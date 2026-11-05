import { env } from "cloudflare:test";
import {
  type EnvironmentVariableId,
  type EnvironmentVariableName,
  type EnvironmentVariableTarget,
  type EnvironmentVariableValue,
  Principal,
  ProjectRepository,
  ThreadRepository,
  type UserId,
  WorkspaceId,
} from "@dx/domain";
import { Effect, Redacted, Schema } from "effect";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { authorizeThread } from "../../src/auth/authorize-thread.js";
import { errorHandler } from "../../src/http/http-errors.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv, Bindings } from "../../src/http/types.js";
import { projectRoutes } from "../../src/projects/routes.js";
import {
  encryptEnvironmentVariable,
  loadConfigEncryptionKeyring,
} from "../../src/settings/environment-variables/encryption.js";
import { resolveExecutionEnvironment } from "../../src/settings/environment-variables/execution.js";
import {
  TEST_CONFIG_ENCRYPTION_KEYS,
  TEST_RUNNER_PROFILE_CATALOG,
} from "../../src/testing/bindings.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

// Change Owner (#1198): the creator of a personal project moves it into
// their workspace, one way. Members then see the project and start their
// own Threads in it; the owner's Threads stay private unless shared. The
// project's own secrets move with it, while the owner's personal secrets
// never reach other members. Workspace policy applies from the move.

const owner = "prjmove-owner" as UserId;
const admin = "prjmove-admin" as UserId;
const member = "prjmove-member" as UserId;
const outsider = "prjmove-outsider" as UserId;
const workspaceId = "prjmove-workspace";
const workspaceSlug = "prjmove-team";

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

const move = (userId: UserId, projectId: string, body: unknown) =>
  send(userId, `/projects/${projectId}/move`, "POST", body);

const user = (id: string, name: string) =>
  env.DB.prepare(
    'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1, 1)',
  ).bind(id, name, `${id}@example.com`);

const scratch = {
  ...project("prj_00000000-0000-4000-8000-00000000f001", owner, "Scratch"),
};
const taken = project(
  "prj_00000000-0000-4000-8000-00000000f002",
  owner,
  "Team App",
);
const teamApp = {
  ...project("prj_00000000-0000-4000-8000-00000000f003", admin, "team app"),
  workspaceId: Schema.decodeUnknownSync(WorkspaceId)(workspaceId),
};
const projectless = project(
  "prj_00000000-0000-4000-8000-00000000f004",
  owner,
  "No Project",
);
const privateThread = thread(
  "thr_00000000-0000-4000-8000-00000000f101",
  scratch.id,
  owner,
);
const sharedThread = thread(
  "thr_00000000-0000-4000-8000-00000000f102",
  scratch.id,
  owner,
);
const memberThread = thread(
  "thr_00000000-0000-4000-8000-00000000f103",
  scratch.id,
  member,
);

beforeEach(async () => {
  background.length = 0;
  await env.DB.batch([
    user(owner, "Owner"),
    user(admin, "Admin"),
    user(member, "Member"),
    user(outsider, "Outsider"),
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, 'Move Team', ?, 1)",
    ).bind(workspaceId, workspaceSlug),
    env.DB.prepare(
      `INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES
         ('prjmove-m-owner', ?1, ?2, 'member', 1),
         ('prjmove-m-admin', ?1, ?3, 'owner', 2),
         ('prjmove-m-member', ?1, ?4, 'member', 3)`,
    ).bind(workspaceId, owner, admin, member),
    // The workspace allows only one Orb size and no public code.
    env.DB.prepare(
      `UPDATE workspace_policy SET allowed_runner_profile_ids = '["a1.medium"]'
        WHERE workspace_id = ?`,
    ).bind(workspaceId),
  ]);
  await runRepositories(
    Effect.gen(function* () {
      const projects = yield* ProjectRepository;
      yield* projects.insert({
        ...scratch,
        configuration: {
          ...scratch.configuration,
          runnerProfileId: "a1.large",
          publicCodeEnabled: true,
        },
      });
      yield* projects.insert(taken);
      yield* projects.insert(teamApp);
      yield* projects.insert(projectless);
      const threads = yield* ThreadRepository;
      yield* threads.insert(privateThread, undefined, {
        provider: "e2b",
        runnerProfileId: "a1.large",
        credentialScope: "personal",
        credentialOwnerId: owner,
        credentialAccount: "owner-team",
        providerTemplate: "test-a1.large",
      });
      yield* threads.insert(sharedThread);
    }),
  );
  await env.DB.batch([
    // The private Thread's Orb runs on the owner's personal E2B key.
    env.DB.prepare(
      "UPDATE execution_workspace SET state = 'provisioning', initialization_attempt_id = 'prjmove-attempt' WHERE thread_id = ?",
    ).bind(privateThread.id),
    env.DB.prepare(
      "UPDATE threads SET workspace_access = 'view', shared_workspace_id = ? WHERE id = ?",
    ).bind(workspaceId, sharedThread.id),
  ]);
});

// A real encrypted value, as Settings stores it.
const storeVariable = async (
  id: string,
  scope: "personal" | "project",
  targetId: string,
  name: string,
  value: string,
) => {
  const target = { scope, id: targetId } as EnvironmentVariableTarget;
  const envelope = await Effect.runPromise(
    Effect.gen(function* () {
      const keyring = yield* loadConfigEncryptionKeyring(bindings);
      return yield* encryptEnvironmentVariable(
        keyring,
        {
          id: id as EnvironmentVariableId,
          target,
          name: name as EnvironmentVariableName,
          kind: "secret",
        },
        value as EnvironmentVariableValue,
      );
    }),
  );
  await env.DB.prepare(
    `INSERT INTO environment_variable (id, scope, target_id, name, kind,
       enabled, policy_locked, envelope_version, key_version, value_nonce,
       ciphertext, wrapped_key_nonce, wrapped_key, created_at, updated_at,
       rotated_at)
     VALUES (?, ?, ?, ?, 'secret', 1, 0, ?, ?, ?, ?, ?, ?, '2026-08-20T12:00:00.000Z', '2026-08-20T12:00:00.000Z', '2026-08-20T12:00:00.000Z')`,
  )
    .bind(
      id,
      scope,
      targetId,
      name,
      envelope.version,
      envelope.keyVersion,
      envelope.valueNonce,
      envelope.ciphertext,
      envelope.wrappedKeyNonce,
      envelope.wrappedKey,
    )
    .run();
};

const listedProjectIds = async (userId: UserId) =>
  (
    await (
      await send(userId, "/projects?limit=50")
    ).json<{
      data: { items: Array<{ id: string }> };
    }>()
  ).data.items.map(({ id }) => id);

const revisionOf = async (projectId: string) =>
  (
    await env.DB.prepare("SELECT revision FROM projects WHERE id = ?")
      .bind(projectId)
      .first<{ revision: number }>()
  )?.revision ?? -1;

const environmentOf = async (threadId: string) => {
  const snapshot = await Effect.runPromise(
    resolveExecutionEnvironment(bindings, threadId),
  );
  return Object.fromEntries(
    snapshot.values.map(({ name, value }) => [name, Redacted.value(value)]),
  );
};

describe("moving a personal project into a workspace in workerd with real D1", () => {
  it("shares the project and its own secrets with members, keeps Threads and personal secrets private, and applies workspace policy", async () => {
    await storeVariable(
      "prjmove-env-1",
      "personal",
      owner,
      "OWNER_TOKEN",
      "owner-only",
    );
    await storeVariable(
      "prjmove-env-2",
      "project",
      scratch.id,
      "PROJECT_TOKEN",
      "project-value",
    );

    // Before: the project is the owner's alone.
    expect(await listedProjectIds(member)).not.toContain(scratch.id);
    expect((await send(member, `/projects/${scratch.id}`)).status).toBe(404);

    const moved = await move(owner, scratch.id, {
      workspaceSlug,
      revision: await revisionOf(scratch.id),
    });
    expect(moved.status).toBe(200);
    await expect(moved.json()).resolves.toMatchObject({
      status: "success",
      data: {
        project: {
          id: scratch.id,
          workspaceId,
          configuration: {
            // The workspace allows a1.medium only, and no public code.
            runnerProfileId: "a1.medium",
            publicCodeEnabled: false,
          },
        },
        stoppedOrbCount: 1,
      },
    });
    await Promise.all(background);

    // Members see the project and may start Threads in it; only its
    // creator and admins manage it.
    expect(await listedProjectIds(member)).toContain(scratch.id);
    const asMember = await send(member, `/projects/${scratch.id}`);
    expect(asMember.status).toBe(200);
    await expect(asMember.json()).resolves.toMatchObject({
      data: {
        viewerAccess: { canManage: false, threads: { status: "available" } },
      },
    });
    await expect(
      (await send(admin, `/projects/${scratch.id}`)).json(),
    ).resolves.toMatchObject({ data: { viewerAccess: { canManage: true } } });
    await expect(
      (await send(owner, `/projects/${scratch.id}`)).json(),
    ).resolves.toMatchObject({ data: { viewerAccess: { canManage: true } } });
    expect(await listedProjectIds(outsider)).not.toContain(scratch.id);

    // The owner's Threads stay private unless shared.
    expect(
      (await send(member, `/thread-access/${privateThread.id}`)).status,
    ).not.toBe(204);
    expect(
      (await send(member, `/thread-access/${sharedThread.id}`)).status,
    ).toBe(204);
    expect(
      (await send(owner, `/thread-access/${privateThread.id}`)).status,
    ).toBe(204);

    // A member's Thread in the moved project gets the project's secret,
    // never the owner's personal one; the owner keeps both.
    await runRepositories(
      Effect.gen(function* () {
        yield* (yield* ThreadRepository).insert(memberThread);
      }),
    );
    const memberEnvironment = await environmentOf(memberThread.id);
    expect(memberEnvironment).toMatchObject({ PROJECT_TOKEN: "project-value" });
    expect(memberEnvironment).not.toHaveProperty("OWNER_TOKEN");
    expect(await environmentOf(sharedThread.id)).toMatchObject({
      PROJECT_TOKEN: "project-value",
      OWNER_TOKEN: "owner-only",
    });

    // One way: a workspace project cannot move again.
    const again = await move(owner, scratch.id, {
      workspaceSlug,
      revision: await revisionOf(scratch.id),
    });
    expect(again.status).toBe(404);
  });

  it("refuses other people, stale revisions, the projectless scope, a taken name, and a workspace that forbids member projects", async () => {
    const body = async (projectId: string) => ({
      workspaceSlug,
      revision: await revisionOf(projectId),
    });

    expect((await move(admin, scratch.id, await body(scratch.id))).status).toBe(
      404,
    );
    expect(
      (
        await move(owner, scratch.id, {
          workspaceSlug,
          revision: (await revisionOf(scratch.id)) + 1,
        })
      ).status,
    ).toBe(404);
    expect(
      (await move(owner, projectless.id, await body(projectless.id))).status,
    ).toBe(404);
    expect((await move(owner, teamApp.id, await body(teamApp.id))).status).toBe(
      404,
    );
    expect((await move(owner, scratch.id, { workspaceSlug })).status).toBe(400);

    // Workspace names are unique regardless of case.
    const conflict = await move(owner, taken.id, await body(taken.id));
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      data: { code: "PROJECT_NAME_CONFLICT" },
    });

    // Someone outside the workspace cannot move a project into it.
    await runRepositories(
      Effect.gen(function* () {
        yield* (yield* ProjectRepository).insert(
          project("prj_00000000-0000-4000-8000-00000000f005", outsider, "Mine"),
        );
      }),
    );
    expect(
      (
        await move(outsider, "prj_00000000-0000-4000-8000-00000000f005", {
          workspaceSlug,
          revision: 0,
        })
      ).status,
    ).toBe(403);

    await env.DB.prepare(
      `INSERT INTO workspace_project_defaults (workspace_id, allow_member_project_creation, updated_at)
       VALUES (?, 0, '2026-08-20T12:00:00.000Z')
       ON CONFLICT (workspace_id) DO UPDATE SET allow_member_project_creation = 0`,
    )
      .bind(workspaceId)
      .run();
    const forbidden = await move(owner, scratch.id, await body(scratch.id));
    expect(forbidden.status).toBe(403);

    // Nothing moved.
    const row = await env.DB.prepare(
      "SELECT workspace_id, runner_profile_id, public_code_enabled FROM projects WHERE id = ?",
    )
      .bind(scratch.id)
      .first();
    expect(row).toEqual({
      workspace_id: null,
      runner_profile_id: "a1.large",
      public_code_enabled: 1,
    });
  });
});
