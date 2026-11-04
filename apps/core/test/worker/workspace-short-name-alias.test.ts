import { env } from "cloudflare:test";
import { Principal, type UserId } from "@dx/domain";
import { Schema } from "effect";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { errorHandler } from "../../src/http/http-errors.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv, Bindings } from "../../src/http/types.js";
import { settingsRoutes } from "../../src/settings/routes.js";
import {
  TEST_CONFIG_ENCRYPTION_KEYS,
  TEST_RUNNER_PROFILE_CATALOG,
} from "../../src/testing/bindings.js";

// A renamed workspace keeps its former short names as aliases (#1382). Its
// members reach it through them on every settings API route; anyone else gets
// the same answer as for a workspace they cannot see.

const owner = "alias-owner" as UserId;
const member = "alias-member" as UserId;
const outsider = "alias-outsider" as UserId;
const otherOwner = "alias-other-owner" as UserId;
const workspaceId = "alias-workspace";
const otherWorkspaceId = "alias-other-workspace";

const bindings: Bindings = {
  DB: env.DB,
  DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
  DX_RUNNER_PROFILE_CATALOG: TEST_RUNNER_PROFILE_CATALOG,
  DX_AUTH_URL: "https://dx.example.test",
};

const executionContext = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
} as unknown as ExecutionContext;

const send = (userId: UserId, path: string, method = "GET", body?: unknown) => {
  const app = new Hono<AppEnv>();
  app.use("*", requestId);
  app.use("*", async (context, next) => {
    context.set(
      "principal",
      Schema.decodeUnknownSync(Principal)({
        userId,
        credentialScopes: ["personal", "workspace"],
      }),
    );
    await next();
  });
  app.route("/settings", settingsRoutes);
  app.onError(errorHandler);
  return app.request(
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
};

const profile = async (userId: UserId, slug: string) => {
  const response = await send(userId, `/settings/workspaces/${slug}`);
  return { status: response.status, body: await response.text() };
};

const revisionOf = async (id: string) =>
  (await env.DB.prepare("SELECT profileRevision FROM organization WHERE id = ?")
    .bind(id)
    .first<number>("profileRevision")) ?? 0;

const rename = async (userId: UserId, id: string, from: string, to: string) => {
  const response = await send(userId, `/settings/workspaces/${from}`, "PATCH", {
    displayName: "Alias Team",
    shortName: to,
    expectedRevision: await revisionOf(id),
  });
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    data: { id, shortName: to },
  });
};

const forbidden = {
  status: "error",
  data: {
    code: "SETTINGS_SCOPE_FORBIDDEN",
    message: "The settings scope is unavailable for this user.",
  },
};

// The body a user gets for a name, minus the per-request ID.
const answerFor = async (userId: UserId, slug: string) => {
  const { status, body } = await profile(userId, slug);
  const parsed = JSON.parse(body) as { data: { requestId?: string } };
  delete parsed.data.requestId;
  return { status, body: parsed };
};

const user = (id: string) =>
  env.DB.prepare(
    'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1, 1)',
  ).bind(id, id, `${id}@example.com`);

beforeEach(async () => {
  await env.DB.batch([
    user(owner),
    user(member),
    user(outsider),
    user(otherOwner),
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, 'Alias Team', 'alias-team', 1)",
    ).bind(workspaceId),
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, 'Other Team', 'other-team', 1)",
    ).bind(otherWorkspaceId),
    env.DB.prepare(
      "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('alias-m1', ?, ?, 'owner', 1)",
    ).bind(workspaceId, owner),
    env.DB.prepare(
      "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('alias-m2', ?, ?, 'member', 1)",
    ).bind(workspaceId, member),
    env.DB.prepare(
      "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('alias-m3', ?, ?, 'owner', 1)",
    ).bind(otherWorkspaceId, otherOwner),
  ]);
});

describe("workspace short-name aliases in workerd with real D1", () => {
  it("opens a renamed workspace by its former name for its members, with the current name", async () => {
    await rename(owner, workspaceId, "alias-team", "renamed-team");

    for (const userId of [owner, member]) {
      const { status, body } = await profile(userId, "alias-team");
      expect(status).toBe(200);
      expect(JSON.parse(body)).toMatchObject({
        status: "success",
        data: { id: workspaceId, shortName: "renamed-team" },
      });
    }
    expect((await profile(member, "renamed-team")).status).toBe(200);
  });

  it("resolves the former name on nested routes and keeps their query", async () => {
    await rename(owner, workspaceId, "alias-team", "renamed-team");

    const members = await send(
      member,
      "/settings/workspaces/alias-team/members",
    );
    expect(members.status).toBe(200);
    await expect(members.json()).resolves.toMatchObject({
      data: {
        viewer: { userId: member, role: "member" },
        members: [{ userId: owner }, { userId: member }],
      },
    });

    const query =
      "from=2026-10-01&to=2026-10-31&timezoneOffsetMinutes=0&limit=5";
    const viaAlias = await send(
      owner,
      `/settings/workspaces/alias-team/usage?${query}`,
    );
    const viaCurrent = await send(
      owner,
      `/settings/workspaces/renamed-team/usage?${query}`,
    );
    expect(viaAlias.status).toBe(200);
    const aliasBody = await viaAlias.json();
    expect(aliasBody).toEqual(await viaCurrent.json());
    expect(aliasBody).toMatchObject({
      data: { range: { from: "2026-10-01", to: "2026-10-31" } },
    });

    // A bad query is still rejected through the alias.
    const invalid = await send(
      owner,
      "/settings/workspaces/alias-team/usage?from=nope",
    );
    expect(invalid.status).toBe(400);
  });

  it("answers a non-member through a former name exactly as through an unknown name", async () => {
    await rename(owner, workspaceId, "alias-team", "renamed-team");

    for (const userId of [outsider, otherOwner]) {
      const viaAlias = await answerFor(userId, "alias-team");
      expect(viaAlias).toEqual({ status: 403, body: forbidden });
      expect(viaAlias).toEqual(await answerFor(userId, "never-existed"));
      expect(viaAlias).toEqual(await answerFor(userId, "renamed-team"));
      expect(JSON.stringify(viaAlias)).not.toContain("renamed-team");
      expect(JSON.stringify(viaAlias)).not.toContain(workspaceId);

      const members = await send(
        userId,
        "/settings/workspaces/alias-team/members",
      );
      expect(members.status).toBe(403);
      expect(await members.text()).not.toContain("renamed-team");
    }
  });

  it("lets another workspace claim a former name at once, which ends the alias", async () => {
    await rename(owner, workspaceId, "alias-team", "renamed-team");

    // The alias does not hold the name.
    await rename(otherOwner, otherWorkspaceId, "other-team", "alias-team");

    expect(await answerFor(member, "alias-team")).toEqual({
      status: 403,
      body: forbidden,
    });
    const members = await send(
      member,
      "/settings/workspaces/alias-team/members",
    );
    expect(members.status).toBe(403);
    expect(await members.text()).not.toContain("Other Team");
    const claimed = await profile(otherOwner, "alias-team");
    expect(claimed.status).toBe(200);
    expect(JSON.parse(claimed.body)).toMatchObject({
      data: { id: otherWorkspaceId, shortName: "alias-team" },
    });
    // The other workspace's own former name now opens it.
    expect((await profile(otherOwner, "other-team")).status).toBe(200);
    expect((await profile(member, "renamed-team")).status).toBe(200);
  });

  it("lets a new workspace take a former name", async () => {
    await rename(owner, workspaceId, "alias-team", "renamed-team");

    const created = await send(outsider, "/settings/workspaces", "POST", {
      displayName: "Newcomers",
      shortName: "alias-team",
    });
    expect(created.status).toBe(201);
    expect((await profile(member, "alias-team")).status).toBe(403);
    const mine = await profile(outsider, "alias-team");
    expect(JSON.parse(mine.body)).toMatchObject({
      data: { displayName: "Newcomers", shortName: "alias-team" },
    });
  });

  it("renames back to a former name and keeps the name it leaves as an alias", async () => {
    await rename(owner, workspaceId, "alias-team", "renamed-team");
    await rename(owner, workspaceId, "alias-team", "alias-team");

    for (const slug of ["alias-team", "renamed-team"]) {
      const { status, body } = await profile(member, slug);
      expect(status).toBe(200);
      expect(JSON.parse(body)).toMatchObject({
        data: { id: workspaceId, shortName: "alias-team" },
      });
    }
    // Another workspace can still take the name it left.
    await rename(otherOwner, otherWorkspaceId, "other-team", "renamed-team");
    expect((await profile(member, "renamed-team")).status).toBe(403);
  });

  it("keeps a workspace's 20 newest former names", async () => {
    const names = Array.from(
      { length: 22 },
      (_, index) => `alias-${String(index).padStart(2, "0")}`,
    );
    let current = "alias-team";
    for (const name of names) {
      await rename(owner, workspaceId, current, name);
      current = name;
    }
    // Former names, oldest first: alias-team, alias-00 ... alias-20.
    const former = ["alias-team", ...names.slice(0, -1)];
    for (const [index, slug] of former.entries()) {
      expect({ slug, status: (await profile(member, slug)).status }).toEqual({
        slug,
        status: index < former.length - 20 ? 403 : 200,
      });
    }
    await expect(
      env.DB.prepare(
        "SELECT COUNT(*) AS count FROM workspace_short_name_alias WHERE workspace_id = ?",
      )
        .bind(workspaceId)
        .first("count"),
    ).resolves.toBe(20);
  });

  it("drops a deleted workspace's former names", async () => {
    await rename(owner, workspaceId, "alias-team", "renamed-team");
    const deleted = await send(
      owner,
      "/settings/workspaces/alias-team/delete",
      "POST",
      { confirmShortName: "renamed-team", threads: "keep" },
    );
    expect(deleted.status).toBe(200);
    await expect(
      env.DB.prepare(
        "SELECT COUNT(*) AS count FROM workspace_short_name_alias WHERE workspace_id = ?",
      )
        .bind(workspaceId)
        .first("count"),
    ).resolves.toBe(0);
    expect((await profile(owner, "alias-team")).status).toBe(403);
  });
});
