import { env } from "cloudflare:test";
import { ProjectRepository, ThreadRepository, UserId } from "@dx/domain";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  type ExecutionWorkspaceRecord,
  makeD1ExecutionWorkspaceStateStore,
} from "../../src/execution/e2b/resolver.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

const owner = Schema.decodeUnknownSync(UserId)("workspace-identity-owner");

describe("execution workspace identity persistence", () => {
  it("creates an uninitialized record with the Thread and permits only one immutable sandbox identity", async () => {
    const suffix = crypto.randomUUID();
    const projectEntity = project(
      `prj_${suffix}`,
      owner,
      "Execution workspace identity",
    );
    const threadEntity = thread(`thr_${suffix}`, projectEntity.id, owner);
    await runRepositories(
      Effect.gen(function* () {
        yield* (yield* ProjectRepository).insert(projectEntity);
        yield* (yield* ThreadRepository).insert(threadEntity);
      }),
    );

    const store = makeD1ExecutionWorkspaceStateStore(env.DB);
    const uninitialized = await store.read(threadEntity.id);
    expect(uninitialized).toEqual({
      state: "uninitialized",
      providerSandboxId: null,
      initializationAttemptId: null,
      conflictCount: null,
    });

    const provisioning: ExecutionWorkspaceRecord = {
      state: "provisioning",
      providerSandboxId: null,
      initializationAttemptId: "attempt-one",
      conflictCount: null,
    };
    await expect(
      store.transition(
        threadEntity.id,
        uninitialized as ExecutionWorkspaceRecord,
        provisioning,
      ),
    ).resolves.toBe(true);

    const initialized: ExecutionWorkspaceRecord = {
      state: "initialized",
      providerSandboxId: "sandbox-one",
      initializationAttemptId: null,
      conflictCount: null,
    };
    await expect(
      store.transition(threadEntity.id, provisioning, initialized),
    ).resolves.toBe(true);

    await expect(
      env.DB.prepare(
        `UPDATE execution_workspace
            SET provider_sandbox_id = 'sandbox-replacement'
          WHERE thread_id = ?`,
      )
        .bind(threadEntity.id)
        .run(),
    ).rejects.toThrow("execution workspace sandbox is immutable");
    await expect(store.read(threadEntity.id)).resolves.toEqual(initialized);

    await expect(
      store.transition(threadEntity.id, initialized, {
        ...initialized,
        state: "lost",
      }),
    ).resolves.toBe(true);
    await expect(store.read(threadEntity.id)).resolves.toEqual({
      ...initialized,
      state: "lost",
    });
  });

  it("lets the first activation pin Cloudflare Containers, and only then", async () => {
    const suffix = crypto.randomUUID();
    const projectEntity = project(`prj_${suffix}`, owner, "Orb provider pin");
    const threadEntity = thread(`thr_${suffix}`, projectEntity.id, owner);
    const other = thread(`thr_${crypto.randomUUID()}`, projectEntity.id, owner);
    await runRepositories(
      Effect.gen(function* () {
        yield* (yield* ProjectRepository).insert(projectEntity);
        yield* (yield* ThreadRepository).insert(threadEntity);
        yield* (yield* ThreadRepository).insert(other);
      }),
    );
    const row = (id: string) =>
      env.DB.prepare(
        "SELECT provider, state, provider_sandbox_id FROM execution_workspace WHERE thread_id = ?",
      )
        .bind(id)
        .first();
    // A new Thread's row names no provider choice yet ('e2b' placeholder).
    await expect(row(threadEntity.id)).resolves.toEqual({
      provider: "e2b",
      state: "uninitialized",
      provider_sandbox_id: null,
    });
    // The provider cannot change outside the first activation.
    await expect(
      env.DB.prepare(
        "UPDATE execution_workspace SET provider = 'cloudflare' WHERE thread_id = ?",
      )
        .bind(threadEntity.id)
        .run(),
    ).rejects.toThrow("execution workspace provider is immutable");
    await expect(
      env.DB.prepare(
        "UPDATE execution_workspace SET provider = 'other', state = 'provisioning', initialization_attempt_id = 'a' WHERE thread_id = ?",
      )
        .bind(threadEntity.id)
        .run(),
    ).rejects.toThrow();
    // The first activation claims it, then it is immutable.
    await env.DB.prepare(
      "UPDATE execution_workspace SET provider = 'cloudflare', state = 'provisioning', initialization_attempt_id = 'attempt' WHERE thread_id = ? AND state = 'uninitialized'",
    )
      .bind(threadEntity.id)
      .run();
    await env.DB.prepare(
      "UPDATE execution_workspace SET state = 'initialized', provider_sandbox_id = 'orb-object-id', initialization_attempt_id = NULL WHERE thread_id = ? AND provider = 'cloudflare'",
    )
      .bind(threadEntity.id)
      .run();
    await expect(row(threadEntity.id)).resolves.toEqual({
      provider: "cloudflare",
      state: "initialized",
      provider_sandbox_id: "orb-object-id",
    });
    await expect(
      env.DB.prepare(
        "UPDATE execution_workspace SET provider = 'e2b' WHERE thread_id = ?",
      )
        .bind(threadEntity.id)
        .run(),
    ).rejects.toThrow("execution workspace provider is immutable");
    // E2B's own store never sees a Cloudflare workspace.
    await expect(
      makeD1ExecutionWorkspaceStateStore(env.DB).read(threadEntity.id),
    ).resolves.toBeUndefined();
    await expect(row(other.id)).resolves.toMatchObject({ provider: "e2b" });

    // Workload identity audits name the Thread's provider.
    await env.DB.prepare(
      `INSERT INTO workload_identity_issuance_audit (
         issuance_id, occurred_at, thread_id, runtime_provider,
         runtime_assurance, audience, effective_ttl_seconds, outcome, reason,
         duration_ms
       ) VALUES (?, ?, ?, 'cloudflare', 'dx_dxd_channel_v1', 'aud', 60,
         'denied', 'authority', 1)`,
    )
      .bind(
        `wid_${crypto.randomUUID().replaceAll("-", "")}0000`,
        new Date().toISOString(),
        threadEntity.id,
      )
      .run();
  });
});
