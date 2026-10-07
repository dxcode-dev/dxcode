import { env } from "cloudflare:test";
import {
  Principal,
  type ProjectId,
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
  inviteAcceptRoutes,
  publicInviteRoutes,
} from "../../src/settings/members/routes.js";
import {
  inviteSignupAdmission,
  leaveWorkspace,
} from "../../src/settings/members/service.js";
import { loadModeProfileOverrides } from "../../src/settings/model-routing/connection-store-d1.js";
import { settingsRoutes } from "../../src/settings/routes.js";
import {
  TEST_CONFIG_ENCRYPTION_KEYS,
  TEST_RUNNER_PROFILE_CATALOG,
} from "../../src/testing/bindings.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

const owner = "members-owner" as UserId;
const member = "members-member" as UserId;
const joiner = "members-joiner" as UserId;
const outsider = "members-outsider" as UserId;
const workspaceId = "members-workspace";
const otherWorkspaceId = "members-other-workspace";
const slug = "members-team";

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

const createApp = (userId: UserId) => {
  const app = new Hono<AppEnv>();
  app.use("*", requestId);
  app.route("/api/invites", publicInviteRoutes);
  app.use("*", async (context, next) => {
    context.set("principal", principal(userId));
    await next();
  });
  app.route("/settings", settingsRoutes);
  app.route("/projects", projectRoutes);
  app.route("/invites", inviteAcceptRoutes);
  app.use("/threads/:threadId", authorizeThread);
  app.get("/threads/:threadId", (context) => context.body(null, 204));
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
  );

const user = (id: string, name: string) =>
  env.DB.prepare(
    'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1, 1)',
  ).bind(id, name, `${id}@example.com`);

beforeEach(async () => {
  await env.DB.batch([
    user(owner, "Owner"),
    user(member, "Member"),
    user(joiner, "Joiner"),
    user(outsider, "Outsider"),
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, 1), (?, ?, ?, 1)",
    ).bind(
      workspaceId,
      "Members Team",
      slug,
      otherWorkspaceId,
      "Other Team",
      "other-team",
    ),
    env.DB.prepare(
      `INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES
         ('m-owner', ?1, ?2, 'owner', 1),
         ('m-member', ?1, ?3, 'member', 2),
         ('m-outsider', ?4, ?5, 'owner', 3)`,
    ).bind(workspaceId, owner, member, otherWorkspaceId, outsider),
  ]);
});

const createLink = async (expiresAt?: string) => {
  const response = await send(
    owner,
    `/settings/workspaces/${slug}/invite-links`,
    "POST",
    { title: "Team link", ...(expiresAt === undefined ? {} : { expiresAt }) },
  );
  expect(response.status).toBe(201);
  const { data } = await response.json<{
    data: { id: string; url: string; status: string };
  }>();
  return { ...data, token: data.url.split("/join/")[1] ?? "" };
};

describe("workspace members in workerd with real D1", () => {
  it("lists members and lets only admins change roles or remove members", async () => {
    const list = await send(member, `/settings/workspaces/${slug}/members`);
    expect(list.status).toBe(200);
    const body = await list.json<{
      data: {
        members: Array<{ userId: string; role: string }>;
        viewer: { role: string };
      };
    }>();
    expect(body.data.viewer.role).toBe("member");
    expect(body.data.members.map(({ userId, role }) => [userId, role])).toEqual(
      [
        [owner, "owner"],
        [member, "member"],
      ],
    );

    const denied = await send(
      member,
      `/settings/workspaces/${slug}/members/${owner}`,
      "PATCH",
      { role: "member" },
    );
    expect(denied.status).toBe(403);

    const ownerChange = await send(
      owner,
      `/settings/workspaces/${slug}/members/${owner}`,
      "PATCH",
      { role: "member" },
    );
    expect(ownerChange.status).toBe(409);

    const promoted = await send(
      owner,
      `/settings/workspaces/${slug}/members/${member}`,
      "PATCH",
      { role: "admin" },
    );
    expect(promoted.status).toBe(200);
    await expect(promoted.json()).resolves.toMatchObject({
      data: { userId: member, role: "admin" },
    });

    const removeOwner = await send(
      member,
      `/settings/workspaces/${slug}/members/${owner}`,
      "DELETE",
    );
    expect(removeOwner.status).toBe(409);

    const outsiderList = await send(
      outsider,
      `/settings/workspaces/${slug}/members`,
    );
    expect(outsiderList.status).toBe(403);
  });

  it("creates copyable invite links, admits invited sign-in, and joins once", async () => {
    const memberCreate = await send(
      member,
      `/settings/workspaces/${slug}/invite-links`,
      "POST",
      { title: "Nope" },
    );
    expect(memberCreate.status).toBe(403);

    const link = await createLink();
    expect(link.url).toMatch(/^https:\/\/dx\.example\.test\/join\//);
    const listed = await send(
      owner,
      `/settings/workspaces/${slug}/invite-links`,
    );
    await expect(listed.json()).resolves.toMatchObject({
      data: { links: [{ id: link.id, url: link.url, status: "active" }] },
    });

    const preview = await send(outsider, `/api/invites/${link.token}`);
    await expect(preview.json()).resolves.toMatchObject({
      data: { status: "valid", workspace: { displayName: "Members Team" } },
    });

    expect(await inviteSignupAdmission(env.DB, `/join/${link.token}`)).toBe(
      true,
    );
    expect(await inviteSignupAdmission(env.DB, "/")).toBe(false);
    const waitlist = (email: string) =>
      env.DB.prepare("SELECT status FROM auth_waitlist WHERE email = ?")
        .bind(email)
        .first();
    // Admission alone records nothing; joining approves the account.
    await expect(waitlist(`${joiner}@example.com`)).resolves.toBeNull();

    const busy = await send(outsider, `/invites/${link.token}/accept`, "POST");
    expect(busy.status).toBe(409);

    const joined = await send(joiner, `/invites/${link.token}/accept`, "POST");
    expect(joined.status).toBe(200);
    await expect(joined.json()).resolves.toMatchObject({
      data: { alreadyMember: false, workspace: { shortName: slug } },
    });
    await expect(waitlist(`${joiner}@example.com`)).resolves.toEqual({
      status: "approved",
    });
    await expect(waitlist(`${outsider}@example.com`)).resolves.toBeNull();
    const again = await send(joiner, `/invites/${link.token}/accept`, "POST");
    await expect(again.json()).resolves.toMatchObject({
      data: { alreadyMember: true },
    });
    await expect(
      env.DB.prepare("SELECT use_count FROM workspace_invite_link WHERE id = ?")
        .bind(link.id)
        .first(),
    ).resolves.toEqual({ use_count: 1 });

    const revoked = await send(
      owner,
      `/settings/workspaces/${slug}/invite-links/${link.id}`,
      "DELETE",
    );
    expect(revoked.status).toBe(200);
    const stale = await send(outsider, `/api/invites/${link.token}`);
    await expect(stale.json()).resolves.toMatchObject({
      data: { status: "revoked" },
    });
    expect(await inviteSignupAdmission(env.DB, `/join/${link.token}`)).toBe(
      false,
    );
  });

  it("rejects expired links and past expiry dates", async () => {
    const past = await send(
      owner,
      `/settings/workspaces/${slug}/invite-links`,
      "POST",
      { title: "Old", expiresAt: "2020-01-01T00:00:00.000Z" },
    );
    expect(past.status).toBe(400);
    const link = await createLink(new Date(Date.now() + 60_000).toISOString());
    await env.DB.prepare(
      "UPDATE workspace_invite_link SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?",
    )
      .bind(link.id)
      .run();
    const preview = await send(joiner, `/api/invites/${link.token}`);
    await expect(preview.json()).resolves.toMatchObject({
      data: { status: "expired" },
    });
    const join = await send(joiner, `/invites/${link.token}/accept`, "POST");
    expect(join.status).toBe(404);
  });

  it("shares workspace Projects, keeps settings with their managers, and returns Threads on rejoin", async () => {
    const workspaceProject = {
      ...project(
        "prj_00000000-0000-4000-8000-000000000a01",
        owner,
        "shared-project",
      ),
      workspaceId: Schema.decodeUnknownSync(WorkspaceId)(workspaceId),
    };
    const privateProject = project(
      "prj_00000000-0000-4000-8000-000000000a02",
      owner,
      "private-project",
    );
    const memberThread = thread(
      "thr_00000000-0000-4000-8000-000000000a03",
      workspaceProject.id,
      member,
    );
    await runRepositories(
      Effect.gen(function* () {
        const projects = yield* ProjectRepository;
        const threads = yield* ThreadRepository;
        yield* projects.insert(workspaceProject);
        yield* projects.insert(privateProject);
        yield* threads.insert(memberThread);
      }),
    );

    const listed = await send(member, "/projects");
    const page = await listed.json<{
      data: {
        items: Array<{
          id: ProjectId;
          viewerAccess?: { canManage: boolean; threads: { status: string } };
        }>;
      };
    }>();
    expect(page.data.items.map(({ id }) => id)).toEqual([workspaceProject.id]);
    expect(page.data.items[0]?.viewerAccess).toEqual({
      canManage: false,
      threads: { status: "available" },
    });
    expect(
      (await send(outsider, `/projects/${workspaceProject.id}`)).status,
    ).toBe(404);

    const rename = await send(
      member,
      `/projects/${workspaceProject.id}`,
      "PATCH",
      { name: "renamed", revision: 0 },
    );
    expect(rename.status).toBe(404);

    expect((await send(member, `/threads/${memberThread.id}`)).status).toBe(
      204,
    );
    const left = await send(
      member,
      `/settings/workspaces/${slug}/leave`,
      "POST",
    );
    expect(left.status).toBe(200);
    expect((await send(member, `/threads/${memberThread.id}`)).status).toBe(
      404,
    );
    expect((await send(member, "/projects")).status).toBe(200);
    await expect(
      (await send(member, "/projects")).json(),
    ).resolves.toMatchObject({ data: { items: [] } });

    const link = await createLink();
    expect(
      (await send(member, `/invites/${link.token}/accept`, "POST")).status,
    ).toBe(200);
    expect((await send(member, `/threads/${memberThread.id}`)).status).toBe(
      204,
    );

    const ownerLeave = await send(
      owner,
      `/settings/workspaces/${slug}/leave`,
      "POST",
    );
    expect(ownerLeave.status).toBe(409);
  });

  it("lists the departing member's running workspace Threads for release", async () => {
    const workspaceProject = {
      ...project(
        "prj_00000000-0000-4000-8000-000000000b01",
        owner,
        "release-project",
      ),
      workspaceId: Schema.decodeUnknownSync(WorkspaceId)(workspaceId),
    };
    const running = thread(
      "thr_00000000-0000-4000-8000-000000000b02",
      workspaceProject.id,
      member,
    );
    const idle = thread(
      "thr_00000000-0000-4000-8000-000000000b03",
      workspaceProject.id,
      member,
    );
    await runRepositories(
      Effect.gen(function* () {
        yield* (yield* ProjectRepository).insert(workspaceProject);
        const threads = yield* ThreadRepository;
        yield* threads.insert(running);
        yield* threads.insert(idle);
      }),
    );
    await env.DB.prepare(
      "UPDATE execution_workspace SET state = 'provisioning', initialization_attempt_id = 'attempt-1' WHERE thread_id = ?",
    )
      .bind(running.id)
      .run();
    expect(
      await leaveWorkspace(env.DB, {
        workspaceId,
        displayName: "Members Team",
        shortName: slug,
        role: "member",
        userId: member,
      }),
    ).toEqual([running.id]);
  });

  it("resolves the Mode Dial as personal, then workspace, then default", async () => {
    const config = (model: string) => ({
      agent: { model, thinking: "medium" },
    });
    const denied = await send(
      member,
      `/settings/workspaces/${slug}/model-routing/profile/modes/high`,
      "PUT",
      config("openai/gpt-5.6-sol"),
    );
    expect(denied.status).toBe(403);
    const saved = await send(
      owner,
      `/settings/workspaces/${slug}/model-routing/profile/modes/high`,
      "PUT",
      config("openai/gpt-5.6-sol"),
    );
    expect(saved.status).toBe(200);
    await expect(saved.json()).resolves.toMatchObject({
      data: {
        modes: { high: { source: "override" }, low: { source: "default" } },
      },
    });

    const inherited = await send(
      member,
      "/settings/personal/model-routing/profile",
    );
    await expect(inherited.json()).resolves.toMatchObject({
      data: {
        modes: {
          high: { source: "workspace", config: config("openai/gpt-5.6-sol") },
          low: { source: "default" },
        },
      },
    });
    expect(
      (await loadModeProfileOverrides(env.DB, member)).get("high"),
    ).toEqual(config("openai/gpt-5.6-sol"));
    // The routing graph and New Thread choices carry the inherited source.
    for (const view of ["graph", "choices"]) {
      const response = await send(
        member,
        `/settings/personal/model-routing/${view}`,
      );
      expect(response.status).toBe(200);
      const body = await response.json<{
        data: { modes: Array<{ mode: string; source: string }> };
      }>();
      expect(body.data.modes.find(({ mode }) => mode === "high")).toMatchObject(
        { source: "workspace" },
      );
    }

    await send(
      member,
      "/settings/personal/model-routing/profile/modes/high",
      "PUT",
      config("anthropic/claude-fable-5-1"),
    );
    expect(
      (await loadModeProfileOverrides(env.DB, member)).get("high"),
    ).toEqual(config("anthropic/claude-fable-5-1"));
    expect((await loadModeProfileOverrides(env.DB, outsider)).has("high")).toBe(
      false,
    );
  });
});
