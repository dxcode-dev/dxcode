import { env } from "cloudflare:test";
import type { Sandbox } from "@flue/runtime";
import { Effect, Redacted } from "effect";
import { describe, expect, it, vi } from "vitest";
import app from "../../src/app.js";
import type { Bindings } from "../../src/http/types.js";
import { muteSpanLogRecords } from "../../src/observability/tracing.js";
import { composeExecutionWorkspaces } from "../../src/plugins/execution/provider.js";
import {
  prefetchExecutionEnvironment,
  resolveExecutionEnvironment,
  resolveExecutionEnvironmentRevision,
} from "../../src/settings/environment-variables/execution.js";
import { withExecutionEnvironment } from "../../src/settings/environment-variables/sandbox.js";
import {
  TEST_CONFIG_ENCRYPTION_KEYS,
  TEST_RUNNER_PROFILE_CATALOG,
} from "../../src/testing/bindings.js";
import { countD1Calls, summarizeD1Calls } from "./d1-call-counter.js";

/**
 * Serial D1 round trips before an agent turn's model request (#1589). From a
 * Durable Object a continent away from D1, each costs about 210 ms, so a
 * run's checks read together, and what the Orb's context discovery needs is
 * read beside them. Every read still goes to the primary: a policy tightened
 * before the run refuses it, and a variable written before the run, or
 * changed after the activation read it, reaches the run's commands.
 */

muteSpanLogRecords();

const origin = "http://dx.test";
const timestamp = "2026-11-03T00:00:00.000Z";

describe("agent turn D1 rounds in workerd with real D1", () => {
  it("checks a run's workspace policy in the target's round, and refuses once the policy is tightened", async () => {
    const owner = "turn-rounds-owner";
    const workspaceId = "turn-rounds-workspace";
    const projectId = "prj_00000000-0000-4000-8000-000000001589";
    const threadId = "thr_00000000-0000-4000-8000-000000001589";
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1, 1)',
      ).bind(owner, owner, `${owner}@example.com`),
      env.DB.prepare(
        "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, 1)",
      ).bind(workspaceId, "Turn Rounds", "turn-rounds"),
      env.DB.prepare(
        "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, 'owner', 1)",
      ).bind(`${owner}-member`, workspaceId, owner),
      env.DB.prepare(
        `INSERT INTO projects (
           id, owner_user_id, workspace_id, name, runner_profile_id,
           created_at, updated_at
         ) VALUES (?, ?, ?, 'Turn Rounds', 'a1.medium', ?, ?)`,
      ).bind(projectId, owner, workspaceId, timestamp, timestamp),
      env.DB.prepare(
        "INSERT INTO threads (id, project_id, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(threadId, projectId, owner, timestamp, timestamp),
    ]);
    const counter = countD1Calls(env.DB);
    const bindings: Bindings = {
      DB: counter.db,
      DX_RUNTIME_MODE: "deployed",
      E2B_API_KEY: "key",
      DX_RUNNER_PROFILE_CATALOG: TEST_RUNNER_PROFILE_CATALOG,
    };
    // Flue's sandbox factory for the Thread's run, over a stand-in pipeline
    // that records the D1 calls made before the Orb would start.
    let callsBeforeActivation: ReturnType<typeof summarizeD1Calls> | undefined;
    const activate = vi.fn(async () => {
      callsBeforeActivation = summarizeD1Calls(counter.calls);
      return {} as Sandbox;
    });
    const run = () => {
      counter.reset();
      return composeExecutionWorkspaces(
        bindings,
        {
          e2b: {
            workspace: { create: vi.fn(), connect: vi.fn(), release: vi.fn() },
          },
        },
        () => ({
          activate,
          reconnect: vi.fn(),
          ensureDaemon: vi.fn(),
          recordResidentTerminalInput: vi.fn(),
          recordResidentTerminalHeartbeat: vi.fn(),
        }),
        [{ providerId: "e2b", capabilities: ["execution.workspace"] }],
      ).sandboxFactory.createSandbox({ id: threadId });
    };

    await run();
    expect(activate).toHaveBeenCalledOnce();
    // The target, the owner's membership, and its policy: one round trip.
    expect(callsBeforeActivation?.roundTrips).toBe(1);
    expect(counter.calls[0]?.sql.join(" ")).toContain("workspace_policy");

    await env.DB.prepare(
      "UPDATE workspace_policy SET allow_remote_runners = 0 WHERE workspace_id = ?",
    )
      .bind(workspaceId)
      .run();
    await expect(run()).rejects.toMatchObject({
      _tag: "WorkspacePolicyDenied",
      reason: "remote-runner-disabled",
    });
    expect(activate).toHaveBeenCalledOnce();

    // Leaving the workspace leaves its policy behind.
    await env.DB.prepare("DELETE FROM member WHERE userId = ?")
      .bind(owner)
      .run();
    await run();
    expect(activate).toHaveBeenCalledTimes(2);
  });

  it("gives a run's commands the variables written before it, and a change made after the activation read them", async () => {
    const projectId = "prj_00000000-0000-4000-8000-000000001590";
    const threadId = "thr_00000000-0000-4000-8000-000000001590";
    const bindings: Bindings = {
      DB: env.DB,
      DX_ENV: "local",
      DX_AUTH_URL: origin,
      DX_AUTH_TRUSTED_ORIGINS: origin,
      DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
      BETTER_AUTH_SECRET: "agent-turn-d1-rounds-secret-000000000",
    };
    const email = `turn-rounds-${crypto.randomUUID()}@example.com`;
    const signup = await app.request(
      "/api/auth/sign-up/email",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin,
          "cf-connecting-ip": "203.0.113.89",
        },
        body: JSON.stringify({
          name: "Turn Rounds",
          email,
          password: "turn-rounds-password-123",
        }),
      },
      bindings,
    );
    expect(signup.status).toBe(200);
    const cookie = signup.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    const ownerId = await env.DB.prepare(
      'SELECT id FROM "user" WHERE email = ?',
    )
      .bind(email)
      .first<string>("id");
    if (ownerId === null) throw new Error("Expected owner identity.");
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO projects (id, owner_user_id, name, created_at, updated_at) VALUES (?, ?, 'Turn Rounds', ?, ?)",
      ).bind(projectId, ownerId, timestamp, timestamp),
      env.DB.prepare(
        "INSERT INTO threads (id, project_id, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(threadId, projectId, ownerId, timestamp, timestamp),
    ]);
    const setVariable = async (name: string, value: string) =>
      expect(
        (
          await app.request(
            "/v1/settings/personal/environment-variables",
            {
              method: "POST",
              headers: { cookie, origin, "content-type": "application/json" },
              body: JSON.stringify({
                scope: "personal",
                name,
                kind: "variable",
                value,
              }),
            },
            bindings,
          )
        ).status,
      ).toBe(201);

    // Written before the run: the activation's early read sees it, and
    // context discovery's resolution uses that read instead of its own.
    await setVariable("BEFORE_RUN", "before");
    const counter = countD1Calls(env.DB);
    const counted = { ...bindings, DB: counter.db };
    prefetchExecutionEnvironment(counted, threadId);
    const prefetched = await Effect.runPromise(
      resolveExecutionEnvironment(counted, threadId),
    );
    expect(summarizeD1Calls(counter.calls).roundTrips).toBe(1);
    expect(
      Object.fromEntries(
        prefetched.values.map(({ name, value }) => [
          name,
          Redacted.value(value),
        ]),
      ).BEFORE_RUN,
    ).toBe("before");

    // Changed after the activation read it: the next command still runs
    // with the change, because each command checks the revision first.
    prefetchExecutionEnvironment(bindings, threadId);
    const commands: Array<Record<string, string> | undefined> = [];
    const sandbox = await withExecutionEnvironment(
      {
        createSandbox: async () =>
          ({
            cwd: "/workspace",
            exec: async (
              _command: string,
              options?: { env?: Record<string, string> },
            ) => {
              commands.push(options?.env);
              return { stdout: "", stderr: "", exitCode: 0 };
            },
          }) as unknown as Sandbox,
      },
      (id) => Effect.runPromise(resolveExecutionEnvironment(bindings, id)),
      (id) =>
        Effect.runPromise(resolveExecutionEnvironmentRevision(bindings, id)),
    ).createSandbox({ id: threadId });
    await setVariable("AFTER_READ", "after");
    await sandbox.exec("true");
    expect(commands[0]).toMatchObject({
      BEFORE_RUN: "before",
      AFTER_READ: "after",
    });
  });
});
