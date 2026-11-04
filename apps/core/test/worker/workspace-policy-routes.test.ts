import { env } from "cloudflare:test";
import { Principal, type ThreadId, type UserId } from "@dx/domain";
import type { Sandbox } from "@flue/runtime";
import { Schema } from "effect";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeExecutionActivation } from "../../src/execution/activation.js";
import { errorHandler } from "../../src/http/http-errors.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv, Bindings } from "../../src/http/types.js";
import { composeExecutionWorkspaces } from "../../src/plugins/execution/provider.js";
import { projectRoutes } from "../../src/projects/routes.js";
import { loadRoutableConnections } from "../../src/settings/model-routing/connection-store-d1.js";
import { settingsRoutes } from "../../src/settings/routes.js";
import { TEST_RUNNER_PROFILE_CATALOG } from "../../src/testing/bindings.js";

const owner = "workspace-policy-owner" as UserId;
const member = "workspace-policy-member" as UserId;
const workspaceId = "workspace-policy-routes";
const workspaceSlug = "policy-routes";
const projectId = "prj_00000000-0000-4000-8000-000000000041";
const threadId = "thr_00000000-0000-4000-8000-000000000041";
const bindings: Bindings = {
  DB: env.DB,
  AI: { run: async () => ({}) } as unknown as Ai,
  DX_RUNNER_PROFILE_CATALOG: TEST_RUNNER_PROFILE_CATALOG,
};

const principal = (userId: UserId) =>
  Schema.decodeUnknownSync(Principal)({
    userId,
    credentialScopes: ["personal", "workspace"],
  });

const createApp = (userId: UserId) => {
  const app = new Hono<AppEnv>();
  app.use("*", requestId);
  app.use("*", async (context, next) => {
    context.set("principal", principal(userId));
    await next();
  });
  app.route("/settings", settingsRoutes);
  app.route("/projects", projectRoutes);
  app.onError(errorHandler);
  return app;
};

const updateBody = (
  expectedRevision: number,
  input: {
    readonly allowedRunnerProfileIds?: ReadonlyArray<string> | null;
    readonly allowRemoteRunners?: boolean;
  } = {},
) => ({
  expectedRevision,
  restrictions: {
    allowedRunnerProfileIds: input.allowedRunnerProfileIds ?? null,
    allowRemoteRunners: input.allowRemoteRunners ?? true,
    allowPersonalProviderOverrides: true,
    allowPersonalMcpOverrides: true,
    allowPersonalSecretOverrides: true,
    allowPersonalPluginOverrides: true,
    allowPersonalExecutionOverrides: false,
  },
});

const put = (body: unknown): RequestInit => ({
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
    ).bind(owner, "Policy Owner", "policy-owner@example.com", 1, 1),
    env.DB.prepare(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
    ).bind(member, "Policy Member", "policy-member@example.com", 1, 1),
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)",
    ).bind(workspaceId, "Policy Routes", workspaceSlug, 1),
    env.DB.prepare(
      "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)",
    ).bind("workspace-policy-owner-member", workspaceId, owner, "owner", 1),
    env.DB.prepare(
      "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)",
    ).bind(
      "workspace-policy-readonly-member",
      workspaceId,
      member,
      "member",
      1,
    ),
    env.DB.prepare(
      `INSERT INTO projects (
         id, owner_user_id, workspace_id, name, runner_profile_id,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'a1.medium', ?, ?)`,
    ).bind(
      projectId,
      owner,
      workspaceId,
      "Policy Project",
      "2026-08-23T00:00:00.000Z",
      "2026-08-23T00:00:00.000Z",
    ),
    env.DB.prepare(
      "INSERT INTO threads (id, project_id, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(
      threadId,
      projectId,
      owner,
      "2026-08-23T00:00:00.000Z",
      "2026-08-23T00:00:00.000Z",
    ),
  ]);
});

describe("workspace policy routes in workerd with real D1", () => {
  it("uses workspace policy to include or suppress personal provider precedence", async () => {
    const timestamp = "2026-09-24T00:00:00.000Z";
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO model_connection (
           id, scope, target_id, name, kind, provider_id,
           fields, enabled, priority, created_at, updated_at
         ) VALUES ('mcon_personal_policy', 'personal', ?, 'Personal',
                   'provider', 'openai', '{}', 1, 0, ?, ?)`,
      ).bind(owner, timestamp, timestamp),
      env.DB.prepare(
        `INSERT INTO model_connection (
           id, scope, target_id, name, kind, provider_id,
           fields, enabled, priority, created_at, updated_at
         ) VALUES ('mcon_workspace_policy', 'workspace', ?, 'Workspace',
                   'provider', 'anthropic', '{}', 1, 0, ?, ?)`,
      ).bind(workspaceId, timestamp, timestamp),
    ]);

    await expect(loadRoutableConnections(env.DB, owner)).resolves.toMatchObject(
      [{ id: "mcon_personal_policy" }, { id: "mcon_workspace_policy" }],
    );

    await env.DB.prepare(
      `UPDATE workspace_policy
       SET allow_personal_provider_overrides = 0, updated_at = ?
       WHERE workspace_id = ?`,
    )
      .bind(timestamp, workspaceId)
      .run();
    await expect(loadRoutableConnections(env.DB, owner)).resolves.toMatchObject(
      [{ id: "mcon_workspace_policy" }],
    );
  });

  it("returns effective policy to members while only owners and admins can mutate", async () => {
    const memberApp = createApp(member);
    const read = await memberApp.request(
      `/settings/workspaces/${workspaceSlug}/policy`,
      {},
      bindings,
    );
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toMatchObject({
      data: {
        revision: 0,
        canUpdate: false,
        workspaceRole: "member",
        restrictions: { allowRemoteRunners: true },
      },
    });

    const denied = await memberApp.request(
      `/settings/workspaces/${workspaceSlug}/policy`,
      put(updateBody(0, { allowRemoteRunners: false })),
      bindings,
    );
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toMatchObject({
      data: { code: "WORKSPACE_POLICY_FORBIDDEN" },
    });
  });

  it("updates enforced restrictions and reports revision conflicts", async () => {
    const app = createApp(owner);
    const endpoint = `/settings/workspaces/${workspaceSlug}/policy`;
    const updated = await app.request(
      endpoint,
      put(updateBody(0, { allowRemoteRunners: false })),
      bindings,
    );
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      data: {
        revision: 1,
        restrictions: { allowRemoteRunners: false },
      },
    });

    const stale = await app.request(endpoint, put(updateBody(0)), bindings);
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({
      data: { code: "WORKSPACE_POLICY_CONFLICT", currentRevision: 1 },
    });
    await expect(
      env.DB.prepare(
        "SELECT outcome, reason FROM workspace_policy_audit_event WHERE workspace_id = ? ORDER BY created_at, id",
      )
        .bind(workspaceId)
        .all(),
    ).resolves.toMatchObject({
      results: expect.arrayContaining([
        { outcome: "success", reason: null },
        { outcome: "rejected", reason: "revision-conflict" },
      ]),
    });
  });

  it("rejects non-catalog runner restrictions", async () => {
    const app = createApp(owner);
    const endpoint = `/settings/workspaces/${workspaceSlug}/policy`;
    const unknownRunner = {
      ...updateBody(0),
      restrictions: {
        ...updateBody(0).restrictions,
        allowedRunnerProfileIds: ["invented-runner"],
      },
    };
    const runnerResponse = await app.request(
      endpoint,
      put(unknownRunner),
      bindings,
    );
    expect(runnerResponse.status).toBe(400);
  });

  it("returns stale runner restrictions verbatim and permits only retention or removal", async () => {
    const app = createApp(owner);
    const endpoint = `/settings/workspaces/${workspaceSlug}/policy`;
    await env.DB.prepare(
      "UPDATE workspace_policy SET allowed_runner_profile_ids = ? WHERE workspace_id = ?",
    )
      .bind('["removed-runner","e2b-default"]', workspaceId)
      .run();

    const read = await app.request(endpoint, {}, bindings);
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toMatchObject({
      data: {
        restrictions: {
          allowedRunnerProfileIds: ["removed-runner", "e2b-default"],
        },
      },
    });

    const retained = updateBody(0, {
      allowedRunnerProfileIds: ["removed-runner", "e2b-default"],
    });
    expect((await app.request(endpoint, put(retained), bindings)).status).toBe(
      200,
    );

    const removed = updateBody(1, {
      allowedRunnerProfileIds: ["e2b-default"],
    });
    expect((await app.request(endpoint, put(removed), bindings)).status).toBe(
      200,
    );

    const introduced = updateBody(2, {
      allowedRunnerProfileIds: ["e2b-default", "another-removed-runner"],
    });
    expect(
      (await app.request(endpoint, put(introduced), bindings)).status,
    ).toBe(400);
  });

  it("enforces runner restrictions again when a run activates the Orb", async () => {
    // Flue's sandbox factory for the Thread's run, over a stand-in pipeline.
    const activate = vi.fn(async () => ({}) as Sandbox);
    const run = () =>
      composeExecutionWorkspaces(
        { ...bindings, DX_RUNTIME_MODE: "deployed", E2B_API_KEY: "key" },
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

    await env.DB.prepare(
      "UPDATE workspace_policy SET allow_remote_runners = 0 WHERE workspace_id = ?",
    )
      .bind(workspaceId)
      .run();
    await expect(run()).rejects.toMatchObject({
      _tag: "WorkspacePolicyDenied",
      reason: "remote-runner-disabled",
    });
    expect(activate).not.toHaveBeenCalled();

    await env.DB.prepare(
      "UPDATE workspace_policy SET allow_remote_runners = 1 WHERE workspace_id = ?",
    )
      .bind(workspaceId)
      .run();
    await run();
    expect(activate).toHaveBeenCalledOnce();
  });

  it("checks the Thread and its runner restrictions before a Terminal wake resumes the Orb", async () => {
    // Core's real activation pipeline over a provider that, like every
    // deployed provider, runs Core's checks before it resumes an Orb; its
    // `resume` stands for the Orb waking.
    const resume = vi.fn(async () => {
      throw new Error("Orb resumed.");
    });
    const connect = async (
      _context: unknown,
      _owner: unknown,
      options: { readonly authorize: () => Promise<void> },
    ) => {
      await options.authorize();
      return resume();
    };
    // A provider that never runs `authorize` itself and doesn't claim to.
    const unchecked = vi.fn(async () => resume());
    const wake = (authorizes = true) =>
      composeExecutionWorkspaces(
        { ...bindings, DX_RUNTIME_MODE: "deployed", E2B_API_KEY: "key" },
        {
          e2b: {
            workspace: authorizes
              ? {
                  create: vi.fn(),
                  connectAuthorizes: true,
                  connect,
                  release: vi.fn(),
                }
              : { create: vi.fn(), connect: unchecked, release: vi.fn() },
            residentDaemon: { install: vi.fn() },
          },
        },
        makeExecutionActivation(),
        [
          {
            providerId: "e2b",
            capabilities: ["execution.workspace", "execution.resident-daemon"],
          },
        ],
      ).ensureDaemon({
        threadId: threadId as ThreadId,
        endpoint: "https://dxd.example.test/",
        mintCredential: vi.fn(),
        awaitRegistration: vi.fn(async () => false),
      });
    const setRemoteRunners = (allowed: boolean) =>
      env.DB.prepare(
        "UPDATE workspace_policy SET allow_remote_runners = ? WHERE workspace_id = ?",
      )
        .bind(allowed ? 1 : 0, workspaceId)
        .run();

    await setRemoteRunners(false);
    await expect(wake()).rejects.toMatchObject({
      _tag: "WorkspacePolicyDenied",
      reason: "remote-runner-disabled",
    });
    await expect(wake(false)).rejects.toMatchObject({
      _tag: "WorkspacePolicyDenied",
    });
    expect(unchecked).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();

    await setRemoteRunners(true);
    await env.DB.prepare(
      "UPDATE threads SET lifecycle_state = 'archived' WHERE id = ?",
    )
      .bind(threadId)
      .run();
    await expect(wake()).rejects.toThrow("Thread is not active.");
    await expect(wake(false)).rejects.toThrow("Thread is not active.");
    expect(unchecked).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();

    await env.DB.prepare(
      "UPDATE threads SET lifecycle_state = 'active' WHERE id = ?",
    )
      .bind(threadId)
      .run();
    await expect(wake()).rejects.toThrow("Orb resumed.");
    expect(resume).toHaveBeenCalledOnce();
    await expect(wake(false)).rejects.toThrow("Orb resumed.");
    expect(unchecked).toHaveBeenCalledOnce();
  });

  it("restarts an Orb through its provider's recover, keeping files, only once the workspace policy admits the Thread (#1592)", async () => {
    const compose = (recover?: ReturnType<typeof vi.fn>) =>
      composeExecutionWorkspaces(
        { ...bindings, DX_RUNTIME_MODE: "deployed", E2B_API_KEY: "key" },
        {
          e2b: {
            workspace: {
              create: vi.fn(),
              connect: vi.fn(),
              release: vi.fn(),
              ...(recover === undefined ? {} : { recover }),
            },
          },
        },
        () => ({
          activate: vi.fn(),
          reconnect: vi.fn(),
          ensureDaemon: vi.fn(),
          recordResidentTerminalInput: vi.fn(),
          recordResidentTerminalHeartbeat: vi.fn(),
        }),
        [{ providerId: "e2b", capabilities: ["execution.workspace"] }],
      );
    const recover = vi.fn(async () => ({ files: "kept" as const }));

    await env.DB.prepare(
      "UPDATE workspace_policy SET allow_remote_runners = 0 WHERE workspace_id = ?",
    )
      .bind(workspaceId)
      .run();
    await expect(compose(recover).restart(threadId)).rejects.toMatchObject({
      _tag: "WorkspacePolicyDenied",
    });
    expect(recover).not.toHaveBeenCalled();

    await env.DB.prepare(
      "UPDATE workspace_policy SET allow_remote_runners = 1 WHERE workspace_id = ?",
    )
      .bind(workspaceId)
      .run();
    await expect(compose(recover).restart(threadId)).resolves.toEqual({
      outcome: "restarted",
      files: "kept",
    });
    // Never drops files: without a save the provider leaves the Orb running.
    expect(recover).toHaveBeenCalledWith(
      expect.anything(),
      { threadId },
      { discardUnsaved: false },
    );
    const unsaved = vi.fn(async () => ({ files: "unsaved" as const }));
    await expect(compose(unsaved).restart(threadId)).resolves.toEqual({
      outcome: "unsaved",
    });
    await expect(compose().restart(threadId)).resolves.toEqual({
      outcome: "unsupported",
    });
  });

  it("restarts from the last save only when the person accepts it, copying the unsaved work out first (#1614)", async () => {
    const order: string[] = [];
    // A full Orb whose save fails: it still answers, so the rescue reads
    // its unsaved work through /dev/shm.
    const guest = (name: string) => ({
      commands: {
        run: vi.fn(async (command: string) => {
          order.push(`${name}: ${command.split("\n")[0]?.slice(0, 24)}`);
          if (command.includes("/dev/shm/dx-rescue.XXXXXX"))
            return {
              stdout: "archive /dev/shm/dx-rescue.Ab12Cd 5 2 1\n",
              stderr: "",
              exitCode: 0,
            };
          if (command.startsWith("dd if="))
            return { stdout: "aGVsbG8=", stderr: "", exitCode: 0 };
          return { stdout: "", stderr: "", exitCode: 0 };
        }),
      },
      files: {
        write: vi.fn(async (path: string) => {
          order.push(`${name}: write ${path.split("/").at(-2)}`);
        }),
      },
    });
    const handles = [guest("full Orb"), guest("restarted Orb")];
    const connect = vi.fn(async () => ({ guest: handles.shift() }));
    const savedAt = Date.parse("2026-11-03T09:00:00.000Z");
    const recover = vi.fn(
      async (
        _context: unknown,
        _owner: unknown,
        options: { readonly discardUnsaved?: boolean },
      ) => {
        order.push(`recover discardUnsaved=${options.discardUnsaved}`);
        return options.discardUnsaved === true
          ? { files: "earlier" as const, savedAt }
          : { files: "unsaved" as const, savedAt };
      },
    );
    const workspaces = composeExecutionWorkspaces(
      { ...bindings, DX_RUNTIME_MODE: "deployed", E2B_API_KEY: "key" },
      {
        e2b: {
          workspace: { create: vi.fn(), connect, release: vi.fn(), recover },
        },
      },
      () => ({
        activate: vi.fn(),
        reconnect: vi.fn(),
        ensureDaemon: vi.fn(),
        recordResidentTerminalInput: vi.fn(),
        recordResidentTerminalHeartbeat: vi.fn(),
      }),
      [{ providerId: "e2b", capabilities: ["execution.workspace"] }],
    );

    // A plain restart never drops files: it says when the last save was.
    await expect(workspaces.restart(threadId)).resolves.toEqual({
      outcome: "unsaved",
      savedAt,
    });
    expect(connect).not.toHaveBeenCalled();

    // Accepted: the unsaved work is copied out before the restart drops it,
    // and put in the restarted Orb.
    const restarted = await workspaces.restart(threadId, {
      discardUnsaved: true,
    });
    expect(restarted).toMatchObject({
      outcome: "restarted",
      files: "earlier",
      savedAt,
      rescue: "copied",
      restored: { changes: 2, commits: 1 },
    });
    const dropped = order.indexOf("recover discardUnsaved=true");
    expect(
      order.slice(0, dropped).some((step) => step.startsWith("full Orb")),
    ).toBe(true);
    expect(order.slice(dropped + 1)).toContain(
      "restarted Orb: write dx-recovered",
    );
  });

  it("enforces runner-profile restrictions during project creation", async () => {
    await env.DB.prepare(
      "UPDATE workspace_policy SET allowed_runner_profile_ids = ? WHERE workspace_id = ?",
    )
      .bind('["different-runner"]', workspaceId)
      .run();
    const response = await createApp(owner).request(
      "/projects",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "denied-policy-project" }),
      },
      bindings,
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        code: "WORKSPACE_POLICY_DENIED",
        reason: "runner-profile-restricted",
      },
    });
  });
});
