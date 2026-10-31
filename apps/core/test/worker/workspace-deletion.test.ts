import { env } from "cloudflare:test";
import {
  Principal,
  ProjectRepository,
  ThreadRepository,
  type UserId,
  WorkspaceId,
} from "@dx/domain";
import { Effect, Schema } from "effect";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { authorizeThread } from "../../src/auth/authorize-thread.js";
import { errorHandler } from "../../src/http/http-errors.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv, Bindings } from "../../src/http/types.js";
import { projectRoutes } from "../../src/projects/routes.js";
import { settingsRoutes } from "../../src/settings/routes.js";
import {
  TEST_CONFIG_ENCRYPTION_KEYS,
  TEST_RUNNER_PROFILE_CATALOG,
} from "../../src/testing/bindings.js";
import { threadRoutes } from "../../src/threads/routes.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

// Deleting a workspace (#1158) and the owner's way out of one: transfer
// ownership, then leave.

const owner = "wsdel-owner" as UserId;
const member = "wsdel-member" as UserId;
const outsider = "wsdel-outsider" as UserId;
const workspaceId = "wsdel-workspace";
const otherWorkspaceId = "wsdel-other";
const slug = "wsdel-team";

const principal = (userId: UserId) =>
  Schema.decodeUnknownSync(Principal)({
    userId,
    credentialScopes: ["personal", "workspace"],
  });

const bindings: Bindings = {
  DB: env.DB,
  DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
  DX_RUNNER_PROFILE_CATALOG: TEST_RUNNER_PROFILE_CATALOG,
  DX_AUTH_URL: "https://dx.example.test",
};

const background: Array<Promise<unknown>> = [];
const executionContext = {
  waitUntil: (promise: Promise<unknown>) => {
    background.push(promise.catch(() => undefined));
  },
  passThroughOnException: () => undefined,
  props: {},
} as unknown as ExecutionContext;

const createApp = (userId: UserId) => {
  const app = new Hono<AppEnv>();
  app.use("*", requestId);
  app.use("*", async (context, next) => {
    context.set("principal", principal(userId));
    await next();
  });
  app.route("/settings", settingsRoutes);
  app.route("/projects", projectRoutes);
  app.use("/thread-access/:threadId", authorizeThread);
  app.get("/thread-access/:threadId", (context) => context.body(null, 204));
  app.route("/threads", threadRoutes);
  app.onError(errorHandler);
  return app;
};

const send = (userId: UserId, path: string, method = "GET", body?: unknown) =>
  createApp(userId).request(
    path,
    {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    },
    bindings,
    executionContext,
  );

const user = (id: string, name: string) =>
  env.DB.prepare(
    'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1, 1)',
  ).bind(id, name, `${id}@example.com`);

const workspaceProject = {
  ...project("prj_00000000-0000-4000-8000-00000000d001", owner, "Shared"),
  workspaceId: Schema.decodeUnknownSync(WorkspaceId)(workspaceId),
};
const memberPersonalProject = project(
  "prj_00000000-0000-4000-8000-00000000d002",
  member,
  "Private",
);
const memberThread = thread(
  "thr_00000000-0000-4000-8000-00000000d101",
  workspaceProject.id,
  member,
);
const ownerThread = thread(
  "thr_00000000-0000-4000-8000-00000000d102",
  workspaceProject.id,
  owner,
);
const memberPrivateThread = thread(
  "thr_00000000-0000-4000-8000-00000000d103",
  memberPersonalProject.id,
  member,
);

const fakeEnvelope = {
  nonce: "n".repeat(16),
  ciphertext: "c".repeat(32),
  wrappedNonce: "w".repeat(16),
  wrappedKey: "k".repeat(64),
};

beforeEach(async () => {
  background.length = 0;
  await env.DB.batch([
    user(owner, "Owner"),
    user(member, "Member"),
    user(outsider, "Outsider"),
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, 1), (?, ?, ?, 1)",
    ).bind(
      workspaceId,
      "Deletion Team",
      slug,
      otherWorkspaceId,
      "Other Team",
      "wsdel-other",
    ),
    env.DB.prepare(
      `INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES
         ('wsdel-m-owner', ?1, ?2, 'owner', 1),
         ('wsdel-m-member', ?1, ?3, 'member', 2),
         ('wsdel-m-outsider', ?4, ?5, 'owner', 3)`,
    ).bind(workspaceId, owner, member, otherWorkspaceId, outsider),
  ]);
  await runRepositories(
    Effect.gen(function* () {
      const projects = yield* ProjectRepository;
      yield* projects.insert(workspaceProject);
      yield* projects.insert(memberPersonalProject);
      const threads = yield* ThreadRepository;
      yield* threads.insert(memberThread);
      yield* threads.insert(ownerThread);
      yield* threads.insert(memberPrivateThread);
    }),
  );
  // The member shares a private Thread with the workspace.
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE threads SET workspace_access = 'view', shared_workspace_id = ? WHERE id = ?",
    ).bind(workspaceId, memberPrivateThread.id),
    // Workspace secrets and keys, and the member's own personal key, which
    // must survive.
    env.DB.prepare(
      `INSERT INTO model_credential (id, scope, target_id, name, envelope_version,
         key_version, value_nonce, ciphertext, wrapped_key_nonce, wrapped_key,
         created_at, updated_at)
       VALUES ('wsdel-cred-ws', 'workspace', ?1, 'Team key', 1, 1, ?3, ?4, ?5, ?6, 'now', 'now'),
              ('wsdel-cred-me', 'personal', ?2, 'My key', 1, 1, ?3, ?4, ?5, ?6, 'now', 'now')`,
    ).bind(
      workspaceId,
      member,
      fakeEnvelope.nonce,
      fakeEnvelope.ciphertext,
      fakeEnvelope.wrappedNonce,
      fakeEnvelope.wrappedKey,
    ),
    env.DB.prepare(
      `INSERT INTO environment_variable (id, scope, target_id, name, kind,
         envelope_version, key_version, value_nonce, ciphertext,
         wrapped_key_nonce, wrapped_key, created_at, updated_at, rotated_at)
       VALUES ('wsdel-env-ws', 'workspace', ?1, 'TEAM_TOKEN', 'secret', 1, 1, ?3, ?4, ?5, ?6, 'now', 'now', 'now'),
              ('wsdel-env-prj', 'project', ?2, 'PROJECT_TOKEN', 'secret', 1, 1, ?3, ?4, ?5, ?6, 'now', 'now', 'now')`,
    ).bind(
      workspaceId,
      workspaceProject.id,
      fakeEnvelope.nonce,
      fakeEnvelope.ciphertext,
      fakeEnvelope.wrappedNonce,
      fakeEnvelope.wrappedKey,
    ),
    env.DB.prepare(
      `INSERT INTO integration_credential (id, owner_scope, owner_id, purpose,
         envelope_version, key_version, value_nonce, ciphertext,
         wrapped_key_nonce, wrapped_key, created_at, rotated_at)
       VALUES ('wsdel-int-cred', 'workspace', ?1, 'access-token', 1, 1, ?2, ?3, ?4, ?5, 'now', 'now')`,
    ).bind(
      workspaceId,
      fakeEnvelope.nonce,
      fakeEnvelope.ciphertext,
      fakeEnvelope.wrappedNonce,
      fakeEnvelope.wrappedKey,
    ),
    env.DB.prepare(
      `INSERT INTO integration_connection (id, owner_scope, owner_id, provider,
         status, health, provider_account_id, provider_account_login,
         granted_scopes, access_token_reference_id, revocation_status,
         created_at, updated_at)
       VALUES ('wsdel-int', 'workspace', ?1, 'gitlab', 'connected', 'healthy',
         'acct', 'team', '[]', 'wsdel-int-cred', 'not-requested', 'now', 'now')`,
    ).bind(workspaceId),
  ]);
  const link = await send(
    owner,
    `/settings/workspaces/${slug}/invite-links`,
    "POST",
    { title: "Team link" },
  );
  expect(link.status).toBe(201);
});

const count = async (sql: string, ...values: ReadonlyArray<string>) =>
  (
    await env.DB.prepare(sql)
      .bind(...values)
      .first<{ n: number }>()
  )?.n;

const lifecycle = async (threadId: string) =>
  (await env.DB.prepare(
    "SELECT lifecycle_state, workspace_access, shared_workspace_id FROM threads WHERE id = ?",
  )
    .bind(threadId)
    .first<{
      lifecycle_state: string;
      workspace_access: string;
      shared_workspace_id: string | null;
    }>()) ?? undefined;

describe("deleting a workspace in workerd with real D1", () => {
  it("lets only the owner delete, after typing the short name", async () => {
    const byMember = await send(
      member,
      `/settings/workspaces/${slug}/delete`,
      "POST",
      { confirmShortName: slug, threads: "keep" },
    );
    expect(byMember.status).toBe(403);
    await expect(byMember.json()).resolves.toMatchObject({
      data: { code: "WORKSPACE_OWNER_REQUIRED" },
    });

    const mistyped = await send(
      owner,
      `/settings/workspaces/${slug}/delete`,
      "POST",
      { confirmShortName: "wsdel-tea", threads: "keep" },
    );
    expect(mistyped.status).toBe(400);
    await expect(mistyped.json()).resolves.toMatchObject({
      data: {
        code: "INVALID_WORKSPACE_MEMBERS_REQUEST",
        fieldErrors: [{ field: "confirmShortName" }],
      },
    });
    expect(
      await count(
        "SELECT count(*) AS n FROM member WHERE organizationId = ?",
        workspaceId,
      ),
    ).toBe(2);
  });

  it("keeps each Thread with its owner, archived and read-only, and erases the rest", async () => {
    const deleted = await send(
      owner,
      `/settings/workspaces/${slug}/delete`,
      "POST",
      { confirmShortName: slug.toUpperCase(), threads: "keep" },
    );
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toMatchObject({
      data: { deleted: true, keptThreadCount: 2, deletedThreadCount: 0 },
    });

    // The workspace is gone for everyone, and its short name is free.
    expect(
      (await send(owner, `/settings/workspaces/${slug}/members`)).status,
    ).toBe(403);
    expect(
      (await send(member, `/settings/workspaces/${slug}/members`)).status,
    ).toBe(403);
    const organization = await env.DB.prepare(
      "SELECT slug, deletedAt FROM organization WHERE id = ?",
    )
      .bind(workspaceId)
      .first<{ slug: string; deletedAt: string | null }>();
    expect(organization?.deletedAt).not.toBeNull();
    expect(organization?.slug).toMatch(/^deleted-[0-9a-f]{16}$/);
    const recreated = await send(member, "/settings/workspaces", "POST", {
      displayName: "Reborn",
      shortName: slug,
    });
    expect(recreated.status).toBe(201);

    // Its Project left every list, soft deleted.
    const projects = await send(owner, "/projects");
    await expect(projects.json()).resolves.toMatchObject({
      data: { items: [] },
    });
    expect(
      await count(
        "SELECT count(*) AS n FROM projects WHERE id = ? AND deleted_at IS NOT NULL",
        workspaceProject.id,
      ),
    ).toBe(1);

    // Each owner keeps their own Thread, archived; nobody reaches another's.
    expect(await lifecycle(memberThread.id)).toMatchObject({
      lifecycle_state: "archived",
    });
    expect(
      (await send(member, `/thread-access/${memberThread.id}`)).status,
    ).toBe(204);
    expect((await send(owner, `/thread-access/${ownerThread.id}`)).status).toBe(
      204,
    );
    expect(
      (await send(owner, `/thread-access/${memberThread.id}`)).status,
    ).toBe(404);
    const archived = await send(
      member,
      "/threads?lifecycleState=archived&limit=20",
    );
    expect(archived.status).toBe(200);
    const archivedIds = (
      await archived.json<{ data: { items: Array<{ id: string }> } }>()
    ).data.items.map(({ id }) => id);
    expect(archivedIds).toContain(memberThread.id);
    expect(archivedIds).not.toContain(ownerThread.id);

    // A kept Thread is never unarchived.
    const unarchive = await send(
      member,
      `/threads/${memberThread.id}/archive`,
      "PATCH",
      { archived: false },
    );
    expect(unarchive.status).toBe(409);
    await expect(unarchive.json()).resolves.toMatchObject({
      data: { code: "THREAD_PROJECT_DELETED" },
    });
    expect(await lifecycle(memberThread.id)).toMatchObject({
      lifecycle_state: "archived",
    });

    // A private Thread shared with the workspace stays, no longer shared.
    expect(await lifecycle(memberPrivateThread.id)).toEqual({
      lifecycle_state: "active",
      workspace_access: "none",
      shared_workspace_id: null,
    });

    // Secrets, keys, connections, invites, and memberships are erased.
    for (const [sql, value] of [
      [
        "SELECT count(*) AS n FROM environment_variable WHERE scope = 'workspace' AND target_id = ?",
        workspaceId,
      ],
      [
        "SELECT count(*) AS n FROM environment_variable WHERE scope = 'project' AND target_id = ?",
        workspaceProject.id,
      ],
      [
        "SELECT count(*) AS n FROM model_credential WHERE scope = 'workspace' AND target_id = ?",
        workspaceId,
      ],
      [
        "SELECT count(*) AS n FROM integration_credential WHERE owner_scope = 'workspace' AND owner_id = ?",
        workspaceId,
      ],
      [
        "SELECT count(*) AS n FROM workspace_invite_link WHERE organization_id = ?",
        workspaceId,
      ],
      [
        "SELECT count(*) AS n FROM member WHERE organizationId = ?",
        workspaceId,
      ],
    ] as const)
      expect(await count(sql, value), sql).toBe(0);
    expect(
      await env.DB.prepare(
        "SELECT status, access_token_reference_id FROM integration_connection WHERE id = 'wsdel-int'",
      ).first(),
    ).toEqual({ status: "disconnected", access_token_reference_id: null });
    // A member's personal key and another workspace are untouched.
    expect(
      await count(
        "SELECT count(*) AS n FROM model_credential WHERE id = 'wsdel-cred-me'",
      ),
    ).toBe(1);
    expect(
      (await send(outsider, "/settings/workspaces/wsdel-other/members")).status,
    ).toBe(200);
  });

  it("deletes every Thread in its Projects when the owner chooses to", async () => {
    const deleted = await send(
      owner,
      `/settings/workspaces/${slug}/delete`,
      "POST",
      { confirmShortName: slug, threads: "delete" },
    );
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toMatchObject({
      data: { deleted: true, keptThreadCount: 0, deletedThreadCount: 2 },
    });
    for (const id of [memberThread.id, ownerThread.id])
      expect(await lifecycle(id)).toMatchObject({ lifecycle_state: "deleted" });
    expect(
      await count(
        "SELECT count(*) AS n FROM thread_deletion WHERE thread_id IN (?, ?)",
        memberThread.id,
        ownerThread.id,
      ),
    ).toBe(2);
    expect(
      (await send(member, `/thread-access/${memberThread.id}`)).status,
    ).toBe(410);
    expect(await lifecycle(memberPrivateThread.id)).toMatchObject({
      lifecycle_state: "active",
      workspace_access: "none",
    });
  });
});

describe("leaving a workspace as its owner", () => {
  it("transfers ownership to a member, then leaves", async () => {
    const refused = await send(
      owner,
      `/settings/workspaces/${slug}/leave`,
      "POST",
    );
    expect(refused.status).toBe(409);

    const byMember = await send(
      member,
      `/settings/workspaces/${slug}/members/${owner}/transfer-ownership`,
      "POST",
    );
    expect(byMember.status).toBe(403);
    const toOutsider = await send(
      owner,
      `/settings/workspaces/${slug}/members/${outsider}/transfer-ownership`,
      "POST",
    );
    expect(toOutsider.status).toBe(404);

    const transferred = await send(
      owner,
      `/settings/workspaces/${slug}/members/${member}/transfer-ownership`,
      "POST",
    );
    expect(transferred.status).toBe(200);
    await expect(transferred.json()).resolves.toMatchObject({
      data: { userId: member, role: "owner" },
    });
    const listed = await send(owner, `/settings/workspaces/${slug}/members`);
    await expect(listed.json()).resolves.toMatchObject({
      data: {
        viewer: { role: "admin" },
        members: [
          { userId: member, role: "owner" },
          { userId: owner, role: "admin" },
        ],
      },
    });

    // The new owner cannot leave without handing it on in turn.
    expect(
      (await send(member, `/settings/workspaces/${slug}/leave`, "POST")).status,
    ).toBe(409);
    expect(
      (await send(owner, `/settings/workspaces/${slug}/leave`, "POST")).status,
    ).toBe(200);
    expect(
      await count(
        "SELECT count(*) AS n FROM member WHERE organizationId = ? AND role = 'owner'",
        workspaceId,
      ),
    ).toBe(1);
  });
});
