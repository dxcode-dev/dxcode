import { env } from "cloudflare:test";
import { Principal, type UserId } from "@dx/domain";
import { Schema } from "effect";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { enforceAgentWorkspacePolicy } from "../../src/auth/enforce-agent-workspace-policy.js";
import { errorHandler } from "../../src/http/http-errors.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv, Bindings } from "../../src/http/types.js";
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

  it("enforces runner restrictions again at native agent admission", async () => {
    const app = new Hono<AppEnv>();
    app.use("*", requestId);
    app.use("/agents/:threadId", enforceAgentWorkspacePolicy);
    app.all("/agents/:threadId", (context) => context.body(null, 204));
    app.onError(errorHandler);

    await env.DB.prepare(
      "UPDATE workspace_policy SET allow_remote_runners = 0 WHERE workspace_id = ?",
    )
      .bind(workspaceId)
      .run();
    const denied = await app.request(`/agents/${threadId}`, {}, bindings);
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toMatchObject({
      data: {
        code: "WORKSPACE_POLICY_DENIED",
        reason: "remote-runner-disabled",
      },
    });

    await env.DB.prepare(
      "UPDATE workspace_policy SET allow_remote_runners = 1 WHERE workspace_id = ?",
    )
      .bind(workspaceId)
      .run();
    const allowed = await app.request(`/agents/${threadId}`, {}, bindings);
    expect(allowed.status).toBe(204);
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
