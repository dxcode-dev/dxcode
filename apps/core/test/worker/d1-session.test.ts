import { env } from "cloudflare:test";
import { ProjectRepository, ThreadRepository, type UserId } from "@dx/domain";
import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import app from "../../src/app.js";
import type { Bindings } from "../../src/http/types.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

/**
 * Every request reads and writes D1 through one D1 session (#1386), so a
 * read-replicated database serves reads near the user and a request still
 * sees its own writes. Across requests, a write's bookmark rides a cookie, so
 * the browser's next read sees the write even from a replica.
 *
 * How it could fail, each covered below:
 * - Better Auth refuses a session-backed binding (it detects D1 by `batch`,
 *   `exec`, and `prepare`), so every sign-in or session read fails.
 * - A write and the read after it in one request use different sessions or
 *   the bare binding, so the response misses its own write.
 * - A write starts on a replica, so its precondition reads are stale.
 * - A write returns no bookmark, or the next request ignores it, so the next
 *   read may come from a replica that has not applied the write.
 * - A malformed or forged bookmark cookie reaches D1, which rejects it, so
 *   every request with that cookie fails.
 * - A read rewrites the bookmark cookie: parallel reads would race it back.
 * - A read after a write the browser did not make (a realtime hint after a
 *   Durable Object's write) ignores the bookmark the hint carried.
 * - A write that carries a bookmark starts on a replica.
 * - Signing out, or a session found ended, leaves the bookmark cookie behind.
 * - A client with no cookie jar (an API token, dxd, a script) writes, then
 *   reads in a later request from a replica that has not applied the write.
 *
 * Local D1 has no replicas, so the constraint each request opens its session
 * with is recorded at the binding: that is what decides where D1 serves it.
 */

const origin = "http://dx.test";
const constraints: Array<string | undefined> = [];
const recordingDb = new Proxy(env.DB, {
  get(target, property) {
    if (property === "withSession")
      return (constraint?: string) => {
        constraints.push(constraint);
        return target.withSession(constraint);
      };
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
const bindings: Bindings = {
  DB: recordingDb,
  DX_ENV: "local",
  DX_RUNTIME_MODE: "local",
  DX_AUTH_URL: origin,
  DX_AUTH_TRUSTED_ORIGINS: origin,
  BETTER_AUTH_SECRET: "d1-session-test-secret-000000000000000",
  DX_STORAGE: env.DX_STORAGE,
  REALTIME_HUB: env.REALTIME_HUB,
};

const projectId = "prj_00000000-0000-4000-8000-000000001386";
const threadId = "thr_00000000-0000-4000-8000-000000001386";
const BOOKMARK_COOKIE = "dx-d1-bookmark";
const BOOKMARK_HEADER = "x-dx-d1-bookmark";
let sessionCookies = "";
let signups = 0;

const cookiesOf = (response: Response) =>
  response.headers.getSetCookie().map((line) => line.split(";", 1)[0] ?? "");

const bookmarkOf = (response: Response) =>
  cookiesOf(response)
    .find((cookie) => cookie.startsWith(`${BOOKMARK_COOKIE}=`))
    ?.slice(BOOKMARK_COOKIE.length + 1);

const send = (path: string, init: RequestInit = {}, extraCookie = "") => {
  const headers = new Headers(init.headers);
  headers.set(
    "cookie",
    [sessionCookies, extraCookie].filter((part) => part !== "").join("; "),
  );
  headers.set("origin", origin);
  return app.request(path, { ...init, headers }, bindings);
};

const rename = (title: string) =>
  send(`/v1/threads/${threadId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
  });

beforeEach(async () => {
  const email = `d1-session-${crypto.randomUUID()}@example.com`;
  const response = await app.request(
    "/api/auth/sign-up/email",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        "cf-connecting-ip": `203.0.113.${++signups}`,
      },
      body: JSON.stringify({
        name: "Session Owner",
        email,
        password: "d1-session-password-123",
      }),
    },
    bindings,
  );
  expect(response.status).toBe(200);
  sessionCookies = cookiesOf(response)
    .filter((cookie) => !cookie.startsWith(`${BOOKMARK_COOKIE}=`))
    .join("; ");
  const user = await env.DB.prepare('SELECT id FROM "user" WHERE email=?')
    .bind(email)
    .first<{ id: UserId }>();
  if (!user) throw new Error("Expected user");
  await runRepositories(
    Effect.gen(function* () {
      yield* (yield* ProjectRepository).insert(
        project(projectId, user.id, "Sessions"),
      );
      yield* (yield* ThreadRepository).insert(
        thread(threadId, projectId as never, user.id),
      );
    }),
  );
  constraints.length = 0;
});

describe("D1 sessions", () => {
  it("signs in through a session-backed binding", async () => {
    const response = await send("/api/auth/get-session");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      user: { name: "Session Owner" },
    });
    expect(constraints).toEqual(["first-unconstrained"]);
  });

  it("starts a write at the primary and answers with its own write", async () => {
    const response = await rename("Renamed in one session");
    expect(response.status).toBe(200);
    expect(constraints).toEqual(["first-primary"]);
    // The handler wrote the title, then read the Thread back for the response.
    expect(await response.json()).toMatchObject({
      data: { id: threadId, title: "Renamed in one session" },
    });
  });

  it("carries a write's bookmark to the next read, which sees the write", async () => {
    const write = await rename("Renamed before the read");
    expect(write.status).toBe(200);
    const bookmark = bookmarkOf(write);
    expect(bookmark).toMatch(/^[0-9a-f-]{8,}$/);
    expect(
      write.headers
        .getSetCookie()
        .find((line) => line.startsWith(`${BOOKMARK_COOKIE}=`)),
    ).toMatch(/HttpOnly/i);

    constraints.length = 0;
    const read = await send(
      `/v1/threads/${threadId}/list-item`,
      {},
      `${BOOKMARK_COOKIE}=${bookmark}`,
    );
    expect(read.status).toBe(200);
    expect(constraints).toEqual([bookmark]);
    expect(await read.json()).toMatchObject({
      data: { id: threadId, title: "Renamed before the read" },
    });
    // Reads never rewrite the bookmark, so parallel reads cannot move it back.
    expect(bookmarkOf(read)).toBeUndefined();
  });

  it("opens a read from the bookmark in its request header, before the cookie", async () => {
    const first = bookmarkOf(await rename("First rename"));
    const second = bookmarkOf(await rename("Second rename"));
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    constraints.length = 0;
    const read = await send(
      `/v1/threads/${threadId}/list-item`,
      { headers: { [BOOKMARK_HEADER]: String(second) } },
      `${BOOKMARK_COOKIE}=${first}`,
    );
    expect(read.status).toBe(200);
    expect(constraints).toEqual([second]);
    expect(await read.json()).toMatchObject({
      data: { title: "Second rename" },
    });
  });

  it("starts a write at the primary even when it carries a bookmark", async () => {
    const bookmark = bookmarkOf(await rename("Before"));
    constraints.length = 0;
    const write = await send(
      `/v1/threads/${threadId}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          [BOOKMARK_HEADER]: String(bookmark),
        },
        body: JSON.stringify({ title: "After" }),
      },
      `${BOOKMARK_COOKIE}=${bookmark}`,
    );
    expect(write.status).toBe(200);
    expect(constraints).toEqual(["first-primary"]);
  });

  it("drops the bookmark cookie when the browser signs out", async () => {
    const bookmark = bookmarkOf(await rename("Before sign-out"));
    const signOut = await send(
      "/api/auth/sign-out",
      { method: "POST" },
      `${BOOKMARK_COOKIE}=${bookmark}`,
    );
    expect(signOut.status).toBe(200);
    expect(
      signOut.headers
        .getSetCookie()
        .find((line) => line.startsWith(`${BOOKMARK_COOKIE}=`)),
    ).toMatch(/Max-Age=0/i);
  });

  it("reads at the primary for a client that keeps no cookies", async () => {
    const owner = await send("/api/auth/get-session");
    expect(owner.status).toBe(200);
    constraints.length = 0;
    const tokenRead = await app.request(
      "/v1/projects",
      { headers: { authorization: "Bearer dxu_not-a-real-token-000000" } },
      bindings,
    );
    expect(tokenRead.status).toBe(401);
    expect(constraints).toEqual(["first-primary"]);
  });

  it("reads without a bookmark from any replica", async () => {
    const read = await send(`/v1/threads/${threadId}/list-item`);
    expect(read.status).toBe(200);
    expect(constraints).toEqual(["first-unconstrained"]);
  });

  it.each([
    ["garbage", "not-a-bookmark"],
    ["too long", "0".repeat(300)],
    ["a constraint name", "first-primary"],
  ])("ignores a %s bookmark cookie or header", async (_name, value) => {
    const fromCookie = await send(
      `/v1/threads/${threadId}/list-item`,
      {},
      `${BOOKMARK_COOKIE}=${value}`,
    );
    const fromHeader = await send(`/v1/threads/${threadId}/list-item`, {
      headers: { [BOOKMARK_HEADER]: value },
    });
    expect(fromCookie.status).toBe(200);
    expect(fromHeader.status).toBe(200);
    expect(constraints).toEqual(["first-unconstrained", "first-unconstrained"]);
  });
});
