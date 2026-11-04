import { env } from "cloudflare:test";
import { Principal, type UserId } from "@dx/domain";
import { Schema } from "effect";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { errorHandler } from "../../src/http/http-errors.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv, Bindings } from "../../src/http/types.js";
import {
  inviteAcceptRoutes,
  publicInviteRoutes,
} from "../../src/settings/members/routes.js";
import { inviteSignupAdmission } from "../../src/settings/members/service.js";
import { settingsRoutes } from "../../src/settings/routes.js";
import {
  TEST_CONFIG_ENCRYPTION_KEYS,
  TEST_RUNNER_PROFILE_CATALOG,
} from "../../src/testing/bindings.js";

// Invite link use limits through the real routes and D1: the limit is
// validated, listed with uses so far, enforced in the join's own batch (so
// people joining at once cannot oversubscribe it), and leaves expiry,
// revocation, and unlimited links working.

const owner = "uses-owner" as UserId;
const outsider = "uses-outsider" as UserId;
const joiners = [
  "uses-joiner-1",
  "uses-joiner-2",
  "uses-joiner-3",
  "uses-joiner-4",
  "uses-joiner-5",
] as ReadonlyArray<UserId>;
const workspaceId = "uses-workspace";
const slug = "uses-team";
const links = `/settings/workspaces/${slug}/invite-links`;

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
  app.route("/invites", inviteAcceptRoutes);
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

interface LinkData {
  readonly id: string;
  readonly url: string;
  readonly status: string;
  readonly useCount: number;
  readonly maxUses?: number;
}

const createLink = async (input: {
  readonly maxUses?: number;
  readonly expiresAt?: string;
}) => {
  const response = await send(owner, links, "POST", {
    title: "Team link",
    ...input,
  });
  expect(response.status).toBe(201);
  const { data } = await response.json<{ data: LinkData }>();
  return { ...data, token: data.url.split("/join/")[1] ?? "" };
};

const listed = async (id: string) => {
  const response = await send(owner, links);
  expect(response.status).toBe(200);
  const { data } = await response.json<{
    data: { links: ReadonlyArray<LinkData> };
  }>();
  return data.links.find((link) => link.id === id);
};

const join = (userId: UserId, token: string) =>
  send(userId, `/invites/${token}/accept`, "POST");

const preview = async (token: string) =>
  (
    await (
      await send(outsider, `/api/invites/${token}`)
    ).json<{
      data: { status: string };
    }>()
  ).data.status;

const useCount = async (id: string) =>
  (
    await env.DB.prepare(
      "SELECT use_count FROM workspace_invite_link WHERE id = ?",
    )
      .bind(id)
      .first<{ use_count: number }>()
  )?.use_count;

const membersJoined = async () =>
  (
    await env.DB.prepare(
      "SELECT count(*) AS n FROM member WHERE organizationId = ? AND role = 'member'",
    )
      .bind(workspaceId)
      .first<{ n: number }>()
  )?.n;

beforeEach(async () => {
  const user = (id: string) =>
    env.DB.prepare(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1, 1)',
    ).bind(id, id, `${id}@example.com`);
  await env.DB.batch([
    user(owner),
    user(outsider),
    ...joiners.map(user),
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, 'Uses Team', ?, 1), ('uses-other', 'Other', 'uses-other', 1)",
    ).bind(workspaceId, slug),
    env.DB.prepare(
      `INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES
         ('uses-m-owner', ?1, ?2, 'owner', 1),
         ('uses-m-outsider', 'uses-other', ?3, 'owner', 2)`,
    ).bind(workspaceId, owner, outsider),
  ]);
});

describe("invite link use limits in workerd with real D1", () => {
  it("accepts a use limit from 1 to 1000 only", async () => {
    for (const maxUses of [0, -1, 1001]) {
      const response = await send(owner, links, "POST", {
        title: "Bad",
        maxUses,
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        data: { fieldErrors: [{ field: "maxUses" }] },
      });
    }
    const fractional = await send(owner, links, "POST", {
      title: "Bad",
      maxUses: 1.5,
    });
    expect(fractional.status).toBe(400);
    const created = await createLink({ maxUses: 1000 });
    expect(created).toMatchObject({ maxUses: 1000, useCount: 0 });
  });

  it("counts only real joins and refuses joins once the link is used up", async () => {
    const [first, second, third] = joiners as [UserId, UserId, UserId];
    const link = await createLink({ maxUses: 2 });
    expect(await listed(link.id)).toMatchObject({
      status: "active",
      useCount: 0,
      maxUses: 2,
    });

    // Someone already in another workspace is refused without taking a use.
    expect((await join(outsider, link.token)).status).toBe(409);
    expect(await useCount(link.id)).toBe(0);

    expect((await join(first, link.token)).status).toBe(200);
    // Opening the link again as a member takes no second use.
    await expect((await join(first, link.token)).json()).resolves.toMatchObject(
      { data: { alreadyMember: true } },
    );
    expect(await useCount(link.id)).toBe(1);
    expect(await preview(link.token)).toBe("valid");

    expect((await join(second, link.token)).status).toBe(200);
    expect(await listed(link.id)).toMatchObject({
      status: "used-up",
      useCount: 2,
      maxUses: 2,
    });
    expect(await preview(link.token)).toBe("used-up");
    expect(await inviteSignupAdmission(env.DB, `/join/${link.token}`)).toBe(
      false,
    );

    const refused = await join(third, link.token);
    expect(refused.status).toBe(404);
    await expect(refused.json()).resolves.toMatchObject({
      data: {
        code: "WORKSPACE_INVITE_INVALID",
        message: "This invite link has been used up.",
      },
    });
    expect(await useCount(link.id)).toBe(2);
    expect(await membersJoined()).toBe(2);

    // A used-up link can still be revoked.
    expect((await send(owner, `${links}/${link.id}`, "DELETE")).status).toBe(
      200,
    );
    expect(await preview(link.token)).toBe("revoked");
  });

  it("gives the last use to exactly one of several people joining at once", async () => {
    const link = await createLink({ maxUses: 1 });
    const responses = await Promise.all(
      joiners.map((joiner) => join(joiner, link.token)),
    );
    expect(responses.map(({ status }) => status).sort((a, b) => a - b)).toEqual(
      [200, 404, 404, 404, 404],
    );
    expect(await useCount(link.id)).toBe(1);
    expect(await membersJoined()).toBe(1);
    expect(await listed(link.id)).toMatchObject({
      status: "used-up",
      useCount: 1,
      maxUses: 1,
    });
  });

  it("keeps unlimited links open and refuses expired or revoked limited links", async () => {
    const unlimited = await createLink({});
    expect(unlimited).not.toHaveProperty("maxUses");
    const results = await Promise.all(
      joiners.map((joiner) => join(joiner, unlimited.token)),
    );
    expect(results.map(({ status }) => status)).toEqual(joiners.map(() => 200));
    const unlimitedListed = await listed(unlimited.id);
    expect(unlimitedListed).toMatchObject({ status: "active", useCount: 5 });
    expect(unlimitedListed).not.toHaveProperty("maxUses");

    for (const joiner of joiners)
      await env.DB.prepare("DELETE FROM member WHERE userId = ?")
        .bind(joiner)
        .run();
    const [first, second] = joiners as [UserId, UserId];

    const expiring = await createLink({
      maxUses: 5,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await env.DB.prepare(
      "UPDATE workspace_invite_link SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?",
    )
      .bind(expiring.id)
      .run();
    expect(await preview(expiring.token)).toBe("expired");
    expect((await join(first, expiring.token)).status).toBe(404);
    expect(await listed(expiring.id)).toMatchObject({
      status: "expired",
      useCount: 0,
      maxUses: 5,
    });

    const revoked = await createLink({ maxUses: 5 });
    expect((await send(owner, `${links}/${revoked.id}`, "DELETE")).status).toBe(
      200,
    );
    expect(await preview(revoked.token)).toBe("revoked");
    const refused = await join(second, revoked.token);
    expect(refused.status).toBe(404);
    await expect(refused.json()).resolves.toMatchObject({
      data: { message: "This invite link was revoked." },
    });
    expect(await useCount(revoked.id)).toBe(0);
    expect(await membersJoined()).toBe(0);
  });
});
