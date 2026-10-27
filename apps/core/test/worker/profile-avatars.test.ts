// Ways profile avatars can fail, each covered below:
// - a non-image, empty, or oversized upload is stored;
// - a workspace member who is not an admin changes the workspace avatar;
// - someone outside the workspace reads its avatar;
// - replacing or removing an avatar leaves the old object in storage or
//   keeps serving it at its old URL;
// - a stored avatar is served with other bytes or another content type;
// - the account, settings context, workspace members, and Thread
//   participants keep showing the old picture after a change.
import { env } from "cloudflare:test";
import { Principal, ThreadId, UserId } from "@dx/domain";
import { Schema } from "effect";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { avatarRoutes } from "../../src/avatars/routes.js";
import { errorHandler } from "../../src/http/http-errors.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv } from "../../src/http/types.js";
import { settingsRoutes } from "../../src/settings/routes.js";
import { threadSharingDecorations } from "../../src/thread-sharing/service.js";

const userId = (value: string) => Schema.decodeUnknownSync(UserId)(value);
const owner = userId("avatar-owner");
const member = userId("avatar-member");
const outsider = userId("avatar-outsider");

const app = (id: UserId) => {
  const routes = new Hono<AppEnv>();
  routes.use("*", requestId);
  routes.use("*", async (context, next) => {
    context.set(
      "principal",
      Schema.decodeUnknownSync(Principal)({
        userId: id,
        credentialScopes: ["personal", "workspace"],
      }),
    );
    await next();
  });
  routes.route("/v1/settings", settingsRoutes);
  routes.route("/v1/avatars", avatarRoutes);
  routes.onError(errorHandler);
  return {
    request: (path: string, init: RequestInit = {}) =>
      routes.request(path, init, { DB: env.DB, DX_STORAGE: env.DX_STORAGE }),
  };
};

const png = (seed: number) =>
  new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, seed]);

const upload = (
  as: UserId,
  path: string,
  body: BodyInit,
  contentType = "image/png",
) =>
  app(as).request(path, {
    method: "PUT",
    headers: { "content-type": contentType },
    body,
  });

const storageKey = (url: string) =>
  new URL(url, "https://dx.test").pathname.replace(/^\/v1\//, "");

const insertIdentity = (id: UserId, index: number) =>
  env.DB.prepare(
    'INSERT INTO "user" (id, name, email, emailVerified, image, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, 1, 1)',
  ).bind(
    id,
    `Avatar User ${index}`,
    `avatar-${index}@example.com`,
    `https://images.example.com/${index}.png`,
  );

beforeEach(async () => {
  await env.DB.batch([
    insertIdentity(owner, 1),
    insertIdentity(member, 2),
    insertIdentity(outsider, 3),
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES ('avatar-workspace', 'Avatar Team', 'avatar-team', 1)",
    ),
    env.DB.prepare(
      "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('avatar-owner-member', 'avatar-workspace', ?, 'owner', 1)",
    ).bind(owner),
    env.DB.prepare(
      "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('avatar-regular-member', 'avatar-workspace', ?, 'member', 1)",
    ).bind(member),
  ]);
});

describe("personal avatars in workerd with real D1 and R2", () => {
  it("stores, serves, replaces, and removes the caller's avatar", async () => {
    const first = await upload(
      owner,
      "/v1/settings/personal/account/avatar",
      png(1),
    );
    expect(first.status).toBe(200);
    const firstUrl = ((await first.json()) as { data: { avatarUrl: string } })
      .data.avatarUrl;
    expect(firstUrl).toMatch(
      /^\/v1\/avatars\/users\/avatar-owner\/[^/]+\.png$/,
    );

    const served = await app(outsider).request(firstUrl);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(png(1));

    const account = await app(owner).request("/v1/settings/personal/account");
    expect(
      ((await account.json()) as { data: { avatarUrl?: string } }).data
        .avatarUrl,
    ).toBe(firstUrl);

    const second = await upload(
      owner,
      "/v1/settings/personal/account/avatar",
      png(2),
      "image/webp",
    );
    const secondUrl = ((await second.json()) as { data: { avatarUrl: string } })
      .data.avatarUrl;
    expect(secondUrl).toMatch(/\.webp$/);
    expect(secondUrl).not.toBe(firstUrl);
    expect((await app(owner).request(firstUrl)).status).toBe(404);
    expect(await env.DX_STORAGE.head(storageKey(firstUrl))).toBeNull();
    const replaced = await app(owner).request(secondUrl);
    expect(replaced.headers.get("content-type")).toBe("image/webp");
    expect(new Uint8Array(await replaced.arrayBuffer())).toEqual(png(2));

    const removed = await app(owner).request(
      "/v1/settings/personal/account/avatar",
      { method: "DELETE" },
    );
    expect(removed.status).toBe(200);
    expect(
      ((await removed.json()) as { data: { avatarUrl?: string } }).data,
    ).not.toHaveProperty("avatarUrl");
    expect((await app(owner).request(secondUrl)).status).toBe(404);
    expect(await env.DX_STORAGE.head(storageKey(secondUrl))).toBeNull();
  });

  it("rejects uploads that are not small images and stores nothing", async () => {
    const rejected = await Promise.all([
      upload(
        owner,
        "/v1/settings/personal/account/avatar",
        "hello",
        "text/plain",
      ),
      upload(owner, "/v1/settings/personal/account/avatar", new Uint8Array()),
      upload(
        owner,
        "/v1/settings/personal/account/avatar",
        new Uint8Array(512 * 1024 + 1),
      ),
      upload(
        owner,
        "/v1/settings/personal/account/avatar",
        png(1),
        "image/svg+xml",
      ),
    ]);
    expect(rejected.map(({ status }) => status)).toEqual([400, 400, 400, 400]);
    const listed = await env.DX_STORAGE.list({
      prefix: `avatars/users/${owner}/`,
    });
    expect(listed.objects).toEqual([]);
    const row = await env.DB.prepare(
      "SELECT avatar_key FROM personal_account WHERE user_id = ?",
    )
      .bind(owner)
      .first<{ avatar_key: string | null }>();
    expect(row?.avatar_key).toBeNull();
  });

  it("shows the uploaded avatar wherever the user appears", async () => {
    const response = await upload(
      member,
      "/v1/settings/personal/account/avatar",
      png(3),
    );
    const avatarUrl = (
      (await response.json()) as { data: { avatarUrl: string } }
    ).data.avatarUrl;

    const members = (await (
      await app(owner).request("/v1/settings/workspaces/avatar-team/members")
    ).json()) as {
      data: { members: Array<{ userId: string; image?: string }> };
    };
    expect(
      members.data.members.find((entry) => entry.userId === member)?.image,
    ).toBe(avatarUrl);
    expect(
      members.data.members.find((entry) => entry.userId === owner)?.image,
    ).toBe("https://images.example.com/1.png");

    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO projects (id, owner_user_id, name, created_at, updated_at) VALUES ('avatar-project', ?, 'Avatar Project', 'now', 'now')",
      ).bind(owner),
      env.DB.prepare(
        "INSERT INTO threads (id, project_id, owner_user_id, created_at, updated_at) VALUES ('thr_00000000-0000-4000-8000-0000000a7a7a', 'avatar-project', ?, 'now', 'now')",
      ).bind(owner),
      env.DB.prepare(
        "INSERT INTO thread_participant (thread_id, user_id, first_seen_at, last_seen_at) VALUES ('thr_00000000-0000-4000-8000-0000000a7a7a', ?, '2026-10-27T00:00:00.000Z', '2026-10-27T00:00:00.000Z')",
      ).bind(member),
    ]);
    const decorations = await threadSharingDecorations(
      env.DB,
      [
        Schema.decodeUnknownSync(ThreadId)(
          "thr_00000000-0000-4000-8000-0000000a7a7a",
        ),
      ],
      { includeParticipants: true },
    );
    const participants = [...decorations.values()][0]?.participants;
    expect(participants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: member, image: avatarUrl }),
        expect.objectContaining({
          userId: owner,
          image: "https://images.example.com/1.png",
        }),
      ]),
    );
  });
});

describe("workspace avatars in workerd with real D1 and R2", () => {
  it("lets an admin set and remove it and members read it", async () => {
    const set = await upload(
      owner,
      "/v1/settings/workspaces/avatar-team/avatar",
      png(4),
      "image/jpeg",
    );
    expect(set.status).toBe(200);
    const workspace = (
      (await set.json()) as {
        data: { avatarUrl: string; revision: number };
      }
    ).data;
    expect(workspace.avatarUrl).toMatch(
      /^\/v1\/avatars\/workspaces\/avatar-workspace\/[^/]+\.jpg$/,
    );
    // An avatar is not a profile edit: an open name edit keeps its revision.
    expect(workspace.revision).toBe(0);

    const memberRead = await app(member).request(workspace.avatarUrl);
    expect(memberRead.status).toBe(200);
    expect(memberRead.headers.get("content-type")).toBe("image/jpeg");
    expect(new Uint8Array(await memberRead.arrayBuffer())).toEqual(png(4));
    expect((await app(outsider).request(workspace.avatarUrl)).status).toBe(404);

    const context = (await (
      await app(member).request("/v1/settings/personal")
    ).json()) as { data: { workspace: { avatarUrl?: string } } };
    expect(context.data.workspace.avatarUrl).toBe(workspace.avatarUrl);
    const profile = (await (
      await app(member).request("/v1/settings/workspaces/avatar-team")
    ).json()) as { data: { avatarUrl?: string } };
    expect(profile.data.avatarUrl).toBe(workspace.avatarUrl);

    const removed = await app(owner).request(
      "/v1/settings/workspaces/avatar-team/avatar",
      { method: "DELETE" },
    );
    expect(removed.status).toBe(200);
    expect(
      ((await removed.json()) as { data: { avatarUrl?: string } }).data,
    ).not.toHaveProperty("avatarUrl");
    expect((await app(member).request(workspace.avatarUrl)).status).toBe(404);
    expect(
      await env.DX_STORAGE.head(storageKey(workspace.avatarUrl)),
    ).toBeNull();
  });

  it("refuses members who cannot update the workspace", async () => {
    const memberUpload = await upload(
      member,
      "/v1/settings/workspaces/avatar-team/avatar",
      png(5),
    );
    expect(memberUpload.status).toBe(403);
    const outsiderUpload = await upload(
      outsider,
      "/v1/settings/workspaces/avatar-team/avatar",
      png(5),
    );
    expect(outsiderUpload.status).toBe(403);
    const memberRemove = await app(member).request(
      "/v1/settings/workspaces/avatar-team/avatar",
      { method: "DELETE" },
    );
    expect(memberRemove.status).toBe(403);
    const listed = await env.DX_STORAGE.list({
      prefix: "avatars/workspaces/avatar-workspace/",
    });
    expect(listed.objects).toEqual([]);
  });
});
