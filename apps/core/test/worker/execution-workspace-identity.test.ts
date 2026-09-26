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
});
