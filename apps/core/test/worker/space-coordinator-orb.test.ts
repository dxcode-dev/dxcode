import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../src/app.js";
import type { Bindings } from "../../src/http/types.js";
import { resolveSpaceCoordinatorOrb } from "../../src/spaces/coordinator-orb.js";
import {
  TEST_CONFIG_ENCRYPTION_KEYS,
  TEST_RUNNER_PROFILE_CATALOG,
} from "../../src/testing/bindings.js";

/**
 * Where a new Claude Code Space's coordinator runs, through the real Space
 * and settings routes over D1. Every token is a dummy; Core makes no
 * Anthropic call beyond the model check when a plan is saved.
 *
 * Ways it could fail, each covered below: a Claude Code Space is created
 * with no Orb chosen anywhere, or its refusal doesn't say where to choose
 * one, or leaves a Space behind; a chosen Orb is ignored and the Space
 * runs in executor mode; the coordinator's Orb clones the Project's
 * repository; the workspace's choice wins over the person's, or isn't used
 * when the person chose none; a workspace member who isn't an admin
 * changes the workspace's choice; clearing a choice leaves it applied.
 */

const origin = "http://dx.test";
const password = "space-coordinator-orb-password-1234";
const bindings: Bindings = {
  DB: env.DB,
  AI: { run: async () => ({}) } as unknown as Ai,
  DX_ENV: "local",
  DX_AUTH_URL: origin,
  DX_AUTH_TRUSTED_ORIGINS: origin,
  DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
  DX_SIGNUP_ENABLED: "true",
  DX_RUNNER_PROFILE_CATALOG: TEST_RUNNER_PROFILE_CATALOG,
  BETTER_AUTH_SECRET: "space-coordinator-orb-secret-000000000000",
  BYOK_CREDENTIAL_COORDINATOR: env.BYOK_CREDENTIAL_COORDINATOR,
};

const TOKEN = `sk-ant-oat01-${"c".repeat(48)}`;
const workspaceId = "wks-coordinator-orb";
const workspaceSlug = "coordinator-orb";

beforeEach(() => {
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (!new URL(request.url).hostname.endsWith("anthropic.com"))
      return real(input, init);
    if (request.url === "https://api.anthropic.com/v1/models?limit=1000")
      return Response.json({ data: [{ id: "claude-haiku-5-5" }] });
    return Response.json({ type: "error" }, { status: 500 });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const signup = async (email: string, index: number) => {
  const response = await app.request(
    "/api/auth/sign-up/email",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        "cf-connecting-ip": `198.51.100.${index}`,
      },
      body: JSON.stringify({ name: "Space Owner", email, password }),
    },
    bindings,
  );
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (cookie === undefined) throw new Error("Expected session cookie.");
  const user = await env.DB.prepare('SELECT id FROM "user" WHERE email = ?')
    .bind(email)
    .first<{ id: string }>();
  if (user === null) throw new Error("Expected user row.");
  return { cookie, userId: user.id };
};

const call = async (
  path: string,
  cookie: string,
  method = "GET",
  body?: unknown,
) => {
  const response = await app.request(
    path,
    {
      method,
      headers: {
        cookie,
        origin,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    bindings,
  );
  return {
    status: response.status,
    // biome-ignore lint/suspicious/noExplicitAny: response shapes are asserted below.
    body: (await response.json()) as any,
  };
};

const connectClaudePlan = async (cookie: string) => {
  const response = await call(
    "/v1/settings/personal/model-routing/connections",
    cookie,
    "POST",
    {
      name: "Claude Pro/Max",
      kind: "provider",
      providerId: "claude-code",
      apiKey: TOKEN,
    },
  );
  expect(response.status).toBe(200);
};

/** A Project bound to a public Git URL: its Threads clone that repository. */
const createProject = async (cookie: string, name: string) => {
  const created = await call("/v1/projects", cookie, "POST", {
    name,
    source: {
      kind: "public-git-url",
      url: "https://github.com/octocat/Hello-World",
    },
  });
  expect(created.status).toBe(201);
  return created.body.data.id as string;
};

const createSpace = (cookie: string, projectId: string) =>
  call("/v1/spaces", cookie, "POST", {
    projectId,
    name: "Coordinator Space",
    sharing: "private",
  });

const threadRow = (threadId: string) =>
  env.DB.prepare(
    "SELECT kind, execution_mode, runner_profile_id FROM threads WHERE id = ?",
  )
    .bind(threadId)
    .first<{
      kind: string;
      execution_mode: string;
      runner_profile_id: string | null;
    }>();

const sourceRows = async (threadId: string) =>
  (
    await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM thread_source_intent WHERE thread_id = ?1)
            + (SELECT COUNT(*) FROM thread_source_snapshot WHERE thread_id = ?1) AS count`,
    )
      .bind(threadId)
      .first<{ count: number }>()
  )?.count;

const spaceCount = async (userId: string) =>
  (
    await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM space JOIN threads ON threads.id = space.thread_id WHERE threads.owner_user_id = ?",
    )
      .bind(userId)
      .first<{ count: number }>()
  )?.count;

const joinWorkspace = async (
  userId: string,
  role: "admin" | "member",
  create: boolean,
) => {
  if (create)
    await env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, 'Coordinator Team', ?, 1)",
    )
      .bind(workspaceId, workspaceSlug)
      .run();
  await env.DB.prepare(
    "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, 1)",
  )
    .bind(`member-${userId}`, workspaceId, userId, role)
    .run();
};

const personal = "/v1/settings/personal/space-coordinator-orb";
const workspace = `/v1/settings/workspaces/${workspaceSlug}/space-coordinator-orb`;

describe("A new Claude Code Space's coordinator Orb", () => {
  it("is refused with no Orb chosen, then runs on the person's choice with no repository", async () => {
    const { cookie, userId } = await signup(
      "space-coordinator-orb-owner@example.com",
      201,
    );
    await connectClaudePlan(cookie);
    const projectId = await createProject(cookie, "coordinator-orb-personal");
    // An ordinary Thread in the Project clones its repository.
    const ordinary = await call("/v1/threads", cookie, "POST", {
      projectId,
      title: "Ordinary",
    });
    expect(ordinary.status).toBe(201);
    expect(await sourceRows(ordinary.body.data.id)).toBe(1);

    const none = await call(personal, cookie);
    expect(none.status).toBe(200);
    expect(none.body.data).toEqual({
      runnerProfileId: null,
      canUpdate: true,
      effective: { kind: "none" },
    });
    const before = await spaceCount(userId);
    const refused = await createSpace(cookie, projectId);
    expect(refused.status).toBe(409);
    expect(refused.body.data.code).toBe("SPACE_ORB_UNAVAILABLE");
    expect(refused.body.data.message).toContain(
      "Settings → Orb Providers → Space coordinator",
    );
    expect(await spaceCount(userId)).toBe(before);

    const saved = await call(personal, cookie, "PUT", {
      runnerProfileId: "a1.small",
    });
    expect(saved.status).toBe(200);
    expect(saved.body.data).toEqual({
      runnerProfileId: "a1.small",
      canUpdate: true,
      effective: {
        kind: "orb",
        runnerProfileId: "a1.small",
        source: "personal",
      },
    });
    const created = await createSpace(cookie, projectId);
    expect(created.status).toBe(201);
    const threadId = created.body.data.space.threadId as string;
    expect(await threadRow(threadId)).toMatchObject({
      kind: "space",
      execution_mode: "orb",
      runner_profile_id: "a1.small",
    });
    // The coordinator's Orb starts empty: no clone, no Project scripts.
    expect(await sourceRows(threadId)).toBe(0);

    // Cleared, it applies no more.
    await call(personal, cookie, "PUT", { runnerProfileId: null });
    expect((await createSpace(cookie, projectId)).body.data.code).toBe(
      "SPACE_ORB_UNAVAILABLE",
    );
  });

  it("takes the workspace's choice when the person has none, and the person's over it; only admins set the workspace's", async () => {
    const admin = await signup("space-coordinator-orb-admin@example.com", 202);
    const member = await signup(
      "space-coordinator-orb-member@example.com",
      203,
    );
    await joinWorkspace(admin.userId, "admin", true);
    await joinWorkspace(member.userId, "member", false);
    await connectClaudePlan(member.cookie);
    const projectId = await createProject(
      member.cookie,
      "coordinator-orb-workspace",
    );

    const refused = await call(workspace, member.cookie, "PUT", {
      runnerProfileId: "a1.medium",
    });
    expect(refused.status).toBe(403);
    expect((await call(workspace, member.cookie)).body.data).toMatchObject({
      runnerProfileId: null,
      canUpdate: false,
    });

    const saved = await call(workspace, admin.cookie, "PUT", {
      runnerProfileId: "a1.medium",
    });
    expect(saved.status).toBe(200);
    expect(await resolveSpaceCoordinatorOrb(bindings, member.userId)).toEqual({
      kind: "orb",
      runnerProfileId: "a1.medium",
      source: "workspace",
    });
    const onWorkspace = await createSpace(member.cookie, projectId);
    expect(onWorkspace.status).toBe(201);
    expect(
      await threadRow(onWorkspace.body.data.space.threadId as string),
    ).toMatchObject({ execution_mode: "orb", runner_profile_id: "a1.medium" });

    await call(personal, member.cookie, "PUT", { runnerProfileId: "a1.small" });
    expect(await resolveSpaceCoordinatorOrb(bindings, member.userId)).toEqual({
      kind: "orb",
      runnerProfileId: "a1.small",
      source: "personal",
    });
    const onPersonal = await createSpace(member.cookie, projectId);
    expect(onPersonal.status).toBe(201);
    expect(
      await threadRow(onPersonal.body.data.space.threadId as string),
    ).toMatchObject({ runner_profile_id: "a1.small" });
  });
});
