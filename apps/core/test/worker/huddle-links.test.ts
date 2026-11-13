import { env } from "cloudflare:test";
import {
  type ProjectId,
  ProjectRepository,
  ThreadRepository,
  type UserId,
} from "@dx/domain";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import app from "../../src/app.js";
import type { Bindings } from "../../src/http/types.js";
import { TEST_CONFIG_ENCRYPTION_KEYS } from "../../src/testing/bindings.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

/**
 * Huddle links through the whole Worker: real sign-in cookies, real D1,
 * `authorizeThread`, and workspace membership. The ways they could fail:
 *
 * 1. A member who can open the Thread follows the link and is refused, or
 *    lands on another Thread.
 * 2. The code only works as copied: without hyphens, in capitals, or with
 *    spaces it is refused.
 * 3. Someone outside the workspace, or signed out, learns the Thread.
 * 4. A private Thread gets a link or a huddle, or a link keeps working
 *    after its Thread turns private.
 * 5. Each copy makes a new code, so earlier links die; or two Threads share
 *    one.
 * 6. Another workspace's short name, or a code with look-alike letters
 *    (i, l, o), still opens it.
 * 7. A Space's link opens it as a plain thread.
 */

const origin = "http://dx.test";
const bindings = {
  DB: env.DB,
  LOADER: env.LOADER,
  REALTIME_HUB: env.REALTIME_HUB,
  DX_ENV: "local",
  DX_AUTH_URL: origin,
  DX_AUTH_TRUSTED_ORIGINS: origin,
  DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
  BETTER_AUTH_SECRET: "huddle-links-secret-0000000000000000000",
} as unknown as Bindings;

let signups = 0;
const signUp = async () => {
  signups += 1;
  const email = `huddle-links-${signups}@example.test`;
  const response = await app.request(
    "/api/auth/sign-up/email",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        "cf-connecting-ip": `192.0.2.${signups + 120}`,
      },
      body: JSON.stringify({
        name: `Huddle Person ${signups}`,
        email,
        password: "huddle-links-password-123",
      }),
    },
    bindings,
  );
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  const userId = (await env.DB.prepare('SELECT id FROM "user" WHERE email = ?')
    .bind(email)
    .first<string>("id")) as UserId;
  return { cookie, userId };
};

let workspaces = 0;
const workspace = async (
  people: ReadonlyArray<{ userId: UserId }>,
): Promise<{ id: string; slug: string }> => {
  workspaces += 1;
  const id = `org_huddle_links_${workspaces}`;
  const slug = `acme-huddle-${workspaces}`;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, 'Acme', ?, 1)",
    ).bind(id, slug),
    ...people.map((person, index) =>
      env.DB.prepare(
        "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, 1)",
      ).bind(
        `${id}-${index}`,
        id,
        person.userId,
        index === 0 ? "owner" : "member",
      ),
    ),
  ]);
  return { id, slug };
};

let threads = 0;
/** A Thread of `owner`'s in `workspaceId`'s Project, private until shared. */
const ownedThread = async (
  owner: { userId: UserId },
  workspaceId: string,
  options: {
    kind?: "thread" | "space";
    title?: string;
    /** The Project is the owner's own, not the workspace's. */
    personalProject?: boolean;
  } = {},
) => {
  threads += 1;
  const n = String(3_100 + threads).padStart(12, "0");
  const projectId = `prj_00000000-0000-4000-8000-${n}` as ProjectId;
  const threadId = `thr_00000000-0000-4000-9000-${n}`;
  await runRepositories(
    Effect.gen(function* () {
      yield* (yield* ProjectRepository).insert(
        project(projectId, owner.userId, `Huddle links ${threads}`),
      );
      yield* (yield* ThreadRepository).insert(
        thread(threadId, projectId, owner.userId),
      );
    }),
  );
  await env.DB.batch([
    env.DB.prepare("UPDATE projects SET workspace_id = ? WHERE id = ?").bind(
      options.personalProject === true ? null : workspaceId,
      projectId,
    ),
    env.DB.prepare("UPDATE threads SET kind = ?, title = ? WHERE id = ?").bind(
      options.kind ?? "thread",
      options.title ?? "Launch review",
      threadId,
    ),
  ]);
  return threadId;
};

const share = (threadId: string, workspaceId: string) =>
  env.DB.prepare(
    "UPDATE threads SET workspace_access = 'view', shared_workspace_id = ? WHERE id = ?",
  )
    .bind(workspaceId, threadId)
    .run();

const unshare = (threadId: string) =>
  env.DB.prepare(
    "UPDATE threads SET workspace_access = 'none', shared_workspace_id = NULL WHERE id = ?",
  )
    .bind(threadId)
    .run();

type Body = {
  status: string;
  data: {
    code?: string;
    workspace?: string;
    path?: string;
    threadId?: string;
    kind?: string;
    name?: string;
  };
};

const request = async (
  cookie: string | undefined,
  path: string,
  method: "GET" | "POST" = "GET",
) => {
  const response = await app.request(
    path,
    {
      method,
      headers: { origin, ...(cookie === undefined ? {} : { cookie }) },
    },
    bindings,
  );
  const text = await response.text();
  return {
    status: response.status,
    body: (text === "" ? {} : JSON.parse(text)) as Body,
  };
};

const copyLink = (cookie: string, threadId: string) =>
  request(cookie, `/v1/threads/${threadId}/huddle/link`, "POST");

const openLink = (cookie: string | undefined, slug: string, code: string) =>
  request(cookie, `/v1/huddle-links/${slug}/${code}`);

/** Three people: an owner, a member of their workspace, an outsider. */
const people = async () => {
  const owner = await signUp();
  const member = await signUp();
  const outsider = await signUp();
  const shared = await workspace([owner, member]);
  // A person belongs to one workspace; the outsider's is another.
  const elsewhere = await workspace([outsider]);
  return { owner, member, outsider, shared, elsewhere };
};

describe("huddle links", () => {
  it("gives a shared Thread one short code that opens it for workspace members, typed any way", async () => {
    const { owner, member, shared } = await people();
    const threadId = await ownedThread(owner, shared.id);
    await share(threadId, shared.id);

    const copied = await copyLink(owner.cookie, threadId);
    expect(copied.status, JSON.stringify(copied.body)).toBe(200);
    const code = copied.body.data.code ?? "";
    // Nine letters without look-alikes, grouped like abc-def-ghk.
    expect(code).toMatch(/^[a-hjkmnp-z]{3}-[a-hjkmnp-z]{3}-[a-hjkmnp-z]{3}$/);
    expect(copied.body.data.workspace).toBe(shared.slug);
    expect(copied.body.data.path).toBe(`/huddle/${shared.slug}/${code}`);

    // Every copy, the member's included, is the same link.
    expect((await copyLink(owner.cookie, threadId)).body.data.code).toBe(code);
    const memberCopy = await copyLink(member.cookie, threadId);
    expect(memberCopy.status).toBe(200);
    expect(memberCopy.body.data.code).toBe(code);

    const bare = code.replaceAll("-", "");
    for (const typed of [
      code,
      bare,
      code.toUpperCase(),
      bare.toUpperCase(),
      `${bare.slice(0, 4)}-${bare.slice(4)}`,
      encodeURIComponent(` ${code.slice(0, 5)} ${code.slice(5)} `),
    ]) {
      const opened = await openLink(member.cookie, shared.slug, typed);
      expect(opened.status, typed).toBe(200);
      expect(opened.body.data).toEqual({
        threadId,
        kind: "thread",
        name: "Launch review",
        code,
      });
    }
    // The workspace's short name is case-insensitive too.
    expect(
      (await openLink(member.cookie, shared.slug.toUpperCase(), bare)).status,
    ).toBe(200);
    // The owner opens their own Thread's link.
    expect((await openLink(owner.cookie, shared.slug, bare)).status).toBe(200);
  });

  it("gives every Thread its own code", async () => {
    const { owner, shared } = await people();
    const first = await ownedThread(owner, shared.id);
    const second = await ownedThread(owner, shared.id);
    await share(first, shared.id);
    await share(second, shared.id);
    const a = (await copyLink(owner.cookie, first)).body.data.code;
    const b = (await copyLink(owner.cookie, second)).body.data.code;
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a).not.toBe(b);
  });

  it("opens a Space's link as the Space", async () => {
    const { owner, member, shared } = await people();
    const spaceId = await ownedThread(owner, shared.id, {
      kind: "space",
      title: "Spaces Stabilization",
    });
    await share(spaceId, shared.id);
    const code = (await copyLink(owner.cookie, spaceId)).body.data.code ?? "";
    const opened = await openLink(member.cookie, shared.slug, code);
    expect(opened.status).toBe(200);
    expect(opened.body.data).toMatchObject({
      threadId: spaceId,
      kind: "space",
      name: "Spaces Stabilization",
    });
  });

  it("tells outsiders and signed-out visitors nothing about the Thread", async () => {
    const { owner, outsider, shared } = await people();
    const threadId = await ownedThread(owner, shared.id);
    await share(threadId, shared.id);
    const code = (await copyLink(owner.cookie, threadId)).body.data.code ?? "";

    const refused = await openLink(outsider.cookie, shared.slug, code);
    expect(refused.status).toBe(403);
    expect(refused.body.data).toMatchObject({ code: "HUDDLE_LINK_FORBIDDEN" });
    expect(JSON.stringify(refused.body)).not.toContain(threadId);
    expect(JSON.stringify(refused.body)).not.toContain("Launch review");

    // An outsider cannot make a link to it either.
    expect((await copyLink(outsider.cookie, threadId)).status).not.toBe(200);

    const signedOut = await openLink(undefined, shared.slug, code);
    expect(signedOut.status).toBe(401);
    expect(JSON.stringify(signedOut.body)).not.toContain(threadId);
  });

  it("refuses unknown codes, another workspace's name, and look-alike letters", async () => {
    const { owner, member, shared, elsewhere } = await people();
    const threadId = await ownedThread(owner, shared.id);
    await share(threadId, shared.id);
    const code = (await copyLink(owner.cookie, threadId)).body.data.code ?? "";

    for (const [slug, typed] of [
      [elsewhere.slug, code],
      ["no-such-workspace", code],
      [shared.slug, "zzz-zzz-zzz" === code ? "yyy-yyy-yyy" : "zzz-zzz-zzz"],
      [shared.slug, "abc-def-ghi"],
      [shared.slug, "abc-def-gh"],
      [shared.slug, `${code}a`],
    ] as const) {
      const opened = await openLink(member.cookie, slug, typed);
      expect(opened.status, `${slug}/${typed}`).toBe(404);
      expect(opened.body.data).toMatchObject({ code: "HUDDLE_LINK_NOT_FOUND" });
    }
  });

  it("never offers a huddle or a link on a private Thread, and stops a link when its Thread turns private", async () => {
    const { owner, member, shared } = await people();
    const privateThread = await ownedThread(owner, shared.id);

    const link = await copyLink(owner.cookie, privateThread);
    expect(link.status).toBe(409);
    expect(link.body.data).toMatchObject({ code: "HUDDLE_PRIVATE" });
    const summary = await request(
      owner.cookie,
      `/v1/threads/${privateThread}/huddle`,
    );
    expect(summary.status).toBe(409);
    expect(summary.body.data).toMatchObject({ code: "HUDDLE_PRIVATE" });
    const join = await request(
      owner.cookie,
      `/v1/threads/${privateThread}/huddle/join`,
      "POST",
    );
    expect(join.status).toBe(409);
    expect(join.body.data).toMatchObject({ code: "HUDDLE_PRIVATE" });

    // Shared, linked, then made private again: in a workspace Project, and
    // in the owner's personal Project shared with their workspace.
    for (const personalProject of [false, true]) {
      const threadId = await ownedThread(owner, shared.id, { personalProject });
      await share(threadId, shared.id);
      const code =
        (await copyLink(owner.cookie, threadId)).body.data.code ?? "";
      expect((await openLink(member.cookie, shared.slug, code)).status).toBe(
        200,
      );
      await unshare(threadId);
      // The member can no longer open the Thread at all.
      const refused = await openLink(member.cookie, shared.slug, code);
      expect(refused.status, `personal ${personalProject}`).toBe(403);
      // The owner still can, but there is no huddle on a private Thread.
      const own = await openLink(owner.cookie, shared.slug, code);
      expect(own.status, `personal ${personalProject}`).toBe(409);
      expect(own.body.data).toMatchObject({ code: "HUDDLE_PRIVATE" });
    }
  });
});
