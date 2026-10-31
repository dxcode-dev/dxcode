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
import {
  TEST_CONFIG_ENCRYPTION_KEYS,
  TEST_RUNNER_PROFILE_CATALOG,
} from "../../src/testing/bindings.js";
import { threadRoutes } from "../../src/threads/routes.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

// Deleting a project (#1128): its creator, or a workspace admin, deletes it
// and chooses whether its Threads are kept archived and read-only or
// deleted.

const owner = "prjdel-owner" as UserId;
const admin = "prjdel-admin" as UserId;
const member = "prjdel-member" as UserId;
const workspaceId = "prjdel-workspace";

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

const remove = (userId: UserId, projectId: string, body: unknown) =>
  send(userId, `/projects/${projectId}/delete`, "POST", body);

const user = (id: string, name: string) =>
  env.DB.prepare(
    'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1, 1)',
  ).bind(id, name, `${id}@example.com`);

const personalProject = project(
  "prj_00000000-0000-4000-8000-00000000e001",
  owner,
  "Scratch",
);
const otherPersonalProject = project(
  "prj_00000000-0000-4000-8000-00000000e002",
  owner,
  "Keeper",
);
const workspaceProject = {
  ...project("prj_00000000-0000-4000-8000-00000000e003", owner, "Team App"),
  workspaceId: Schema.decodeUnknownSync(WorkspaceId)(workspaceId),
};
const personalThread = thread(
  "thr_00000000-0000-4000-8000-00000000e101",
  personalProject.id,
  owner,
);
const otherThread = thread(
  "thr_00000000-0000-4000-8000-00000000e102",
  otherPersonalProject.id,
  owner,
);
const ownerTeamThread = thread(
  "thr_00000000-0000-4000-8000-00000000e103",
  workspaceProject.id,
  owner,
);
const memberTeamThread = thread(
  "thr_00000000-0000-4000-8000-00000000e104",
  workspaceProject.id,
  member,
);

const fakeEnvelope = [
  "n".repeat(16),
  "c".repeat(32),
  "w".repeat(16),
  "k".repeat(64),
] as const;

beforeEach(async () => {
  background.length = 0;
  await env.DB.batch([
    user(owner, "Owner"),
    user(admin, "Admin"),
    user(member, "Member"),
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, 'Project Team', 'prjdel-team', 1)",
    ).bind(workspaceId),
    env.DB.prepare(
      `INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES
         ('prjdel-m-owner', ?1, ?2, 'owner', 1),
         ('prjdel-m-admin', ?1, ?3, 'admin', 2),
         ('prjdel-m-member', ?1, ?4, 'member', 3)`,
    ).bind(workspaceId, owner, admin, member),
  ]);
  await runRepositories(
    Effect.gen(function* () {
      const projects = yield* ProjectRepository;
      yield* projects.insert(personalProject);
      yield* projects.insert(otherPersonalProject);
      yield* projects.insert(workspaceProject);
      const threads = yield* ThreadRepository;
      yield* threads.insert(personalThread);
      yield* threads.insert(otherThread);
      yield* threads.insert(ownerTeamThread);
      yield* threads.insert(memberTeamThread);
    }),
  );
  const now = new Date().toISOString();
  await env.DB.batch([
    // The personal Thread is shared with the workspace, and wakes on a
    // schedule and a GitHub subscription.
    env.DB.prepare(
      "UPDATE threads SET workspace_access = 'view', shared_workspace_id = ? WHERE id = ?",
    ).bind(workspaceId, personalThread.id),
    env.DB.prepare(
      `INSERT INTO thread_schedule (thread_id, owner_user_id, title, prompt, rrule, time_zone, label, run_mode, enabled, next_run_at, created_at, updated_at)
       VALUES (?, ?, 'Nightly', 'Run it', 'FREQ=DAILY', 'UTC', 'Daily', 'existing', 1, ?, ?, ?)`,
    ).bind(personalThread.id, owner, now, now, now),
    env.DB.prepare(
      `INSERT INTO github_subscription (id, owner_user_id, thread_id, title, repository, filter_kind, filter_json, destination, automatic, enabled, state, equivalence_key, next_poll_at, created_at, updated_at)
       VALUES (?, ?, ?, 'CI', 'o/r', 'ci', '{}', 'this-thread', 0, 1, 'active', ?, ?, ?, ?)`,
    ).bind(
      `ghs_${"e".repeat(32)}`,
      owner,
      personalThread.id,
      "f".repeat(64),
      now,
      now,
      now,
    ),
    // Each project has a secret.
    env.DB.prepare(
      `INSERT INTO environment_variable (id, scope, target_id, name, kind,
         envelope_version, key_version, value_nonce, ciphertext,
         wrapped_key_nonce, wrapped_key, created_at, updated_at, rotated_at)
       VALUES ('prjdel-env-1', 'project', ?1, 'TOKEN', 'secret', 1, 1, ?4, ?5, ?6, ?7, 'now', 'now', 'now'),
              ('prjdel-env-2', 'project', ?2, 'TOKEN', 'secret', 1, 1, ?4, ?5, ?6, ?7, 'now', 'now', 'now'),
              ('prjdel-env-3', 'project', ?3, 'TOKEN', 'secret', 1, 1, ?4, ?5, ?6, ?7, 'now', 'now', 'now')`,
    ).bind(
      personalProject.id,
      otherPersonalProject.id,
      workspaceProject.id,
      ...fakeEnvelope,
    ),
  ]);
});

const count = async (sql: string, ...values: ReadonlyArray<string>) =>
  (
    await env.DB.prepare(sql)
      .bind(...values)
      .first<{ n: number }>()
  )?.n;

const threadRow = async (threadId: string) =>
  (await env.DB.prepare(
    "SELECT lifecycle_state, workspace_access, shared_workspace_id FROM threads WHERE id = ?",
  )
    .bind(threadId)
    .first<{
      lifecycle_state: string;
      workspace_access: string;
      shared_workspace_id: string | null;
    }>()) ?? undefined;

const listedProjectIds = async (userId: UserId) =>
  (
    await (
      await send(userId, "/projects?limit=50")
    ).json<{
      data: { items: Array<{ id: string }> };
    }>()
  ).data.items.map(({ id }) => id);

describe("deleting a project in workerd with real D1", () => {
  it("refuses a wrong confirmation, a member who cannot manage it, and the projectless scope", async () => {
    const mistyped = await remove(owner, personalProject.id, {
      confirmName: "Scratc",
      threads: "keep",
    });
    expect(mistyped.status).toBe(400);
    await expect(mistyped.json()).resolves.toMatchObject({
      data: { code: "PROJECT_NAME_MISMATCH" },
    });

    const invalid = await remove(owner, personalProject.id, {
      confirmName: "Scratch",
      threads: "archive",
    });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({
      data: { code: "INVALID_REQUEST" },
    });

    // A plain member sees the workspace project but cannot delete it.
    const byMember = await remove(member, workspaceProject.id, {
      confirmName: "Team App",
      threads: "delete",
    });
    expect(byMember.status).toBe(404);
    // Nobody else deletes a personal project.
    const byAdmin = await remove(admin, personalProject.id, {
      confirmName: "Scratch",
      threads: "delete",
    });
    expect(byAdmin.status).toBe(404);

    const projectless = await env.DB.prepare(
      "INSERT INTO projects (id, owner_user_id, name, created_at, updated_at) VALUES ('prj_00000000-0000-4000-8000-00000000e0ff', ?, 'No Project', 'now', 'now') RETURNING id",
    )
      .bind(owner)
      .first<{ id: string }>();
    const byProjectless = await remove(owner, projectless?.id ?? "", {
      confirmName: "No Project",
      threads: "keep",
    });
    expect(byProjectless.status).toBe(404);

    expect(
      await count(
        "SELECT count(*) AS n FROM projects WHERE deleted_at IS NOT NULL",
      ),
    ).toBe(0);
    for (const id of [
      personalThread.id,
      ownerTeamThread.id,
      memberTeamThread.id,
    ])
      expect(await threadRow(id)).toMatchObject({ lifecycle_state: "active" });
  });

  it("keeps its Threads archived and read-only, frees its name, and erases its secrets", async () => {
    const deleted = await remove(owner, personalProject.id, {
      confirmName: "  scratch ",
      threads: "keep",
    });
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toEqual({
      status: "success",
      data: { deleted: true, keptThreadCount: 1, deletedThreadCount: 0 },
    });
    await Promise.all(background);

    // The project leaves the list and every read, soft deleted.
    expect(await listedProjectIds(owner)).toEqual(
      expect.not.arrayContaining([personalProject.id]),
    );
    expect(await listedProjectIds(owner)).toContain(otherPersonalProject.id);
    expect((await send(owner, `/projects/${personalProject.id}`)).status).toBe(
      404,
    );
    expect(
      await count(
        "SELECT count(*) AS n FROM projects WHERE id = ? AND deleted_at IS NOT NULL",
        personalProject.id,
      ),
    ).toBe(1);
    // Deleting it again finds nothing.
    expect(
      (
        await remove(owner, personalProject.id, {
          confirmName: "Scratch",
          threads: "keep",
        })
      ).status,
    ).toBe(404);

    // Its Thread stays with its owner, archived, and no longer shared.
    expect(await threadRow(personalThread.id)).toEqual({
      lifecycle_state: "archived",
      workspace_access: "none",
      shared_workspace_id: null,
    });
    expect(
      (await send(owner, `/thread-access/${personalThread.id}`)).status,
    ).toBe(204);
    expect(
      (await send(member, `/thread-access/${personalThread.id}`)).status,
    ).toBe(404);
    const archived = await send(
      owner,
      "/threads?lifecycleState=archived&limit=20",
    );
    expect(archived.status).toBe(200);
    expect(
      (
        await archived.json<{ data: { items: Array<{ id: string }> } }>()
      ).data.items.map(({ id }) => id),
    ).toContain(personalThread.id);

    // Its detail carries the project's name, which can no longer be read.
    const detail = await send(owner, `/threads/${personalThread.id}`);
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      data: {
        lifecycleState: "archived",
        projectName: "Scratch",
        projectDeleted: true,
      },
    });
    const live = await (await send(owner, `/threads/${otherThread.id}`)).json<{
      data: Record<string, unknown>;
    }>();
    expect(live.data.projectDeleted).toBeUndefined();

    // It is never unarchived.
    const unarchive = await send(
      owner,
      `/threads/${personalThread.id}/archive`,
      "PATCH",
      { archived: false },
    );
    expect(unarchive.status).toBe(409);
    await expect(unarchive.json()).resolves.toMatchObject({
      data: { code: "THREAD_PROJECT_DELETED" },
    });
    expect(await threadRow(personalThread.id)).toMatchObject({
      lifecycle_state: "archived",
    });

    // Nothing wakes it, and the project's secret is gone; another
    // project's Thread and secret are untouched.
    for (const [sql, value] of [
      [
        "SELECT count(*) AS n FROM thread_schedule WHERE thread_id = ?",
        personalThread.id,
      ],
      [
        "SELECT count(*) AS n FROM github_subscription WHERE thread_id = ?",
        personalThread.id,
      ],
      [
        "SELECT count(*) AS n FROM environment_variable WHERE scope = 'project' AND target_id = ?",
        personalProject.id,
      ],
    ] as const)
      expect(await count(sql, value), sql).toBe(0);
    expect(
      await count(
        "SELECT count(*) AS n FROM environment_variable WHERE scope = 'project' AND target_id = ?",
        otherPersonalProject.id,
      ),
    ).toBe(1);
    expect(await threadRow(otherThread.id)).toMatchObject({
      lifecycle_state: "active",
    });

    // The name is free for a new project.
    await runRepositories(
      Effect.gen(function* () {
        const projects = yield* ProjectRepository;
        yield* projects.insert(
          project("prj_00000000-0000-4000-8000-00000000e004", owner, "Scratch"),
        );
      }),
    );
    expect(await listedProjectIds(owner)).toContain(
      "prj_00000000-0000-4000-8000-00000000e004",
    );
  });

  it("lets a workspace admin delete a workspace project and every Thread in it", async () => {
    const deleted = await remove(admin, workspaceProject.id, {
      confirmName: "Team App",
      threads: "delete",
    });
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toMatchObject({
      data: { deleted: true, keptThreadCount: 0, deletedThreadCount: 2 },
    });
    await Promise.all(background);

    for (const userId of [owner, admin, member])
      expect(await listedProjectIds(userId)).toEqual(
        expect.not.arrayContaining([workspaceProject.id]),
      );
    // Each member's Thread is deleted, and each owner is told so.
    for (const [id, threadOwner] of [
      [ownerTeamThread.id, owner],
      [memberTeamThread.id, member],
    ] as const) {
      expect(await threadRow(id)).toMatchObject({ lifecycle_state: "deleted" });
      expect((await send(threadOwner, `/thread-access/${id}`)).status).toBe(
        410,
      );
    }
    expect(
      await count(
        "SELECT count(*) AS n FROM thread_deletion WHERE thread_id IN (?, ?)",
        ownerTeamThread.id,
        memberTeamThread.id,
      ),
    ).toBe(2);
    expect(
      await count(
        "SELECT count(*) AS n FROM environment_variable WHERE scope = 'project' AND target_id = ?",
        workspaceProject.id,
      ),
    ).toBe(0);
    // Projects outside it are untouched.
    expect(await threadRow(personalThread.id)).toMatchObject({
      lifecycle_state: "active",
      workspace_access: "view",
    });
  });
});
