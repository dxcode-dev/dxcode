import { env } from "cloudflare:test";
import {
  type ProjectId,
  ProjectRepository,
  ThreadRepository,
  UserId,
} from "@dx/domain";
import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../../src/app.js";
import type { Bindings } from "../../src/http/types.js";
import { portalSigningKey } from "../../src/portals/crypto.js";
import { PUBLIC_LINK_CACHE_MS } from "../../src/portals/public-links.js";
import { encodePortalSession } from "../../src/portals/session.js";
import portalWorker from "../../src/portals/worker.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

const appOrigin = "http://dx.test";
const portalDomain = "dxportal.test";
const secret = "portal-integration-secret-0000000000000000";
const baseBindings = {
  DB: env.DB,
  DX_ENV: "local",
  DX_RUNTIME_MODE: "deployed",
  DX_AUTH_URL: appOrigin,
  DX_AUTH_TRUSTED_ORIGINS: appOrigin,
  BETTER_AUTH_SECRET: secret,
  DX_PORTAL_DOMAIN: portalDomain,
} satisfies Bindings;

interface RelayCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string;
}

/** A Thread execution namespace that records what the relay asked for. */
const fakeExecution = (
  respond: (request: Request) => Response | Promise<Response> = () =>
    new Response("guest says hi", {
      headers: { "content-type": "text/plain" },
    }),
) => {
  const calls: Array<RelayCall> = [];
  const names: Array<string> = [];
  const namespace = {
    idFromName: (name: string) => {
      names.push(name);
      return { name };
    },
    get: () => ({
      fetch: async (request: Request) => {
        calls.push({
          url: request.url,
          method: request.method,
          headers: new Headers(request.headers),
          body:
            request.method === "GET" || request.method === "HEAD"
              ? ""
              : await request.text(),
        });
        return respond(request);
      },
    }),
  } as unknown as DurableObjectNamespace;
  return { namespace, calls, names };
};

let sequence = 0;
const signUp = async (label: string, name = `Portal ${label} Ü`) => {
  sequence += 1;
  const email = `portal-${label}-${crypto.randomUUID()}@example.com`;
  const response = await app.request(
    `${appOrigin}/api/auth/sign-up/email`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: appOrigin,
        // Better Auth rate-limits sign-ups per client address.
        "cf-connecting-ip": `198.51.100.${sequence % 250}`,
      },
      body: JSON.stringify({
        name,
        email,
        password: "portal-password-123",
      }),
    },
    baseBindings,
  );
  expect(response.status).toBe(200);
  const cookie = response.headers
    .get("set-cookie")
    ?.match(/better-auth\.session_token=[^;,]+/)?.[0];
  if (cookie === undefined) throw new Error("Expected a session cookie.");
  const userId = await env.DB.prepare('SELECT id FROM "user" WHERE email = ?')
    .bind(email)
    .first<string>("id");
  if (userId === null) throw new Error("Expected a user.");
  // With Better Auth's cookie cache: the signed session snapshot it trusts for an hour.
  const cached = response.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0] ?? "")
    .filter((value) => /^better-auth\.session_data=./.test(value));
  return {
    cookie,
    cachedCookie: [cookie, ...cached].join("; "),
    email,
    userId: Schema.decodeSync(UserId)(userId),
  };
};

const createThread = async (ownerUserId: UserId) => {
  sequence += 1;
  const suffix = `${Date.now().toString(16).slice(-8)}${String(sequence).padStart(4, "0")}`;
  const projectEntity = project(
    `prj_00000000-0000-4000-8000-${suffix}`,
    ownerUserId,
    `Portal project ${suffix}`,
  );
  const threadEntity = thread(
    `thr_00000000-0000-4000-8000-${suffix}`,
    projectEntity.id as ProjectId,
    ownerUserId,
  );
  await runRepositories(
    Effect.gen(function* () {
      yield* (yield* ProjectRepository).insert(projectEntity);
      yield* (yield* ThreadRepository).insert(threadEntity);
    }),
  );
  return threadEntity.id;
};

const portalOriginFor = (threadId: string, port: number) =>
  `https://t-${threadId.slice(4)}-p${port}.${portalDomain}`;

const navigation = {
  accept: "text/html",
  "sec-fetch-mode": "navigate",
  "sec-fetch-dest": "document",
  "sec-fetch-site": "none",
};

const setCookies = (response: Response) => response.headers.getSetCookie();
const cookieValue = (response: Response, name: string) =>
  setCookies(response)
    .find((cookie) => cookie.startsWith(`${name}=`))
    ?.split(";", 1)[0]
    ?.slice(name.length + 1);

/** Runs the whole handshake; returns the Portal session cookie header. */
const signInToPortal = async (
  bindings: Bindings,
  threadId: string,
  port: number,
  sessionCookie: string,
  path = "/",
  // A public port shows anonymous visitors a page; members sign in from it.
  firstPath = path,
) => {
  const origin = portalOriginFor(threadId, port);
  const start = await app.request(
    `${origin}${firstPath}`,
    { headers: navigation },
    bindings,
  );
  expect(start.status).toBe(302);
  const state = cookieValue(start, "__Host-dx_portal_state");
  const authorize = new URL(start.headers.get("location") ?? "");
  const granted = await app.request(
    authorize.href,
    { headers: { cookie: sessionCookie, ...navigation } },
    bindings,
  );
  expect(granted.status).toBe(302);
  const callback = new URL(granted.headers.get("location") ?? "");
  const completed = await app.request(
    callback.href,
    {
      headers: { cookie: `__Host-dx_portal_state=${state}`, ...navigation },
    },
    bindings,
  );
  expect(completed.status).toBe(302);
  const session = cookieValue(completed, "__Host-dx_portal");
  if (session === undefined) throw new Error("Expected a Portal session.");
  return {
    start,
    authorize,
    granted,
    callback,
    completed,
    state: state as string,
    cookie: `__Host-dx_portal=${session}`,
  };
};

describe("Portal host routing in workerd", () => {
  it("answers malformed Portal hosts with 404 and never reaches the Thread", async () => {
    const execution = fakeExecution();
    const bindings = { ...baseBindings, THREAD_EXECUTION: execution.namespace };
    const uuid = "00000000-0000-4000-8000-0000000000a1";
    const hosts = [
      portalDomain,
      `t-${uuid}-p0.${portalDomain}`,
      `t-${uuid}-p65536.${portalDomain}`,
      `t-${uuid}-p080.${portalDomain}`,
      `t-${uuid}-p.${portalDomain}`,
      `t-${uuid}.${portalDomain}`,
      `t-00000000-0000-1000-8000-0000000000a1-p80.${portalDomain}`,
      `t-thr_${uuid}-p80.${portalDomain}`,
      `x.t-${uuid}-p80.${portalDomain}`,
      `t-${uuid}-p80-x.${portalDomain}`,
      `www.${portalDomain}`,
    ];
    for (const host of hosts) {
      const page = await app.request(
        `https://${host}/`,
        { headers: navigation },
        bindings,
      );
      expect(page.status, host).toBe(404);
      expect(page.headers.get("content-type"), host).toContain("text/html");
      expect(await page.text(), host).toContain("This Portal does not exist");
      const plain = await app.request(
        `https://${host}/asset.js`,
        { headers: { "sec-fetch-dest": "script" } },
        bindings,
      );
      expect(plain.status, host).toBe(404);
      expect(plain.headers.get("content-type"), host).toContain("text/plain");
    }
    expect(execution.calls).toHaveLength(0);

    // The app keeps its own host, and an unconfigured deployment has no
    // Portals at all: the Portal-shaped host falls through to the app's 404.
    expect(
      (await app.request(`${appOrigin}/healthz`, {}, bindings)).status,
    ).toBe(200);
    const unconfigured = await app.request(
      `https://t-${uuid}-p80.${portalDomain}/`,
      { headers: navigation },
      { ...bindings, DX_PORTAL_DOMAIN: undefined },
    );
    expect(unconfigured.status).toBe(404);
    expect(unconfigured.headers.get("content-type")).toContain(
      "application/json",
    );
    expect(execution.calls).toHaveLength(0);
  });

  it("refuses unauthenticated requests at the edge without waking anything", async () => {
    const execution = fakeExecution();
    const bindings = { ...baseBindings, THREAD_EXECUTION: execution.namespace };
    const threadId = "thr_00000000-0000-4000-8000-0000000000a2";
    const origin = portalOriginFor(threadId, 5173);

    const start = await app.request(
      `${origin}/dashboard?tab=1`,
      { headers: navigation },
      bindings,
    );
    expect(start.status).toBe(302);
    const location = new URL(start.headers.get("location") ?? "");
    expect(location.origin).toBe(appOrigin);
    expect(location.pathname).toBe("/v1/portal-auth/authorize");
    expect(location.searchParams.get("thread")).toBe(threadId);
    expect(location.searchParams.get("port")).toBe("5173");
    expect(location.searchParams.get("return")).toBe("/dashboard?tab=1");
    const state = location.searchParams.get("state") ?? "";
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(setCookies(start)).toEqual([
      `__Host-dx_portal_state=${state}; Max-Age=300; Path=/; HttpOnly; Secure; SameSite=None; Partitioned`,
    ]);
    expect(start.headers.get("cache-control")).toBe("no-store");

    // curl-like clients without Fetch Metadata are sent to sign in too.
    expect((await app.request(`${origin}/`, {}, bindings)).status).toBe(302);

    const notNavigations: Array<[string, RequestInit]> = [
      [
        "script fetch",
        {
          headers: {
            "sec-fetch-mode": "cors",
            "sec-fetch-site": "same-origin",
          },
        },
      ],
      [
        "POST",
        {
          method: "POST",
          body: "x",
          headers: {
            "sec-fetch-mode": "navigate",
            "sec-fetch-site": "same-origin",
          },
        },
      ],
      [
        "WebSocket",
        { headers: { upgrade: "websocket", origin, "sec-websocket-key": "a" } },
      ],
    ];
    for (const [name, init] of notNavigations) {
      const response = await app.request(`${origin}/api`, init, bindings);
      expect(response.status, name).toBe(401);
      expect(response.headers.get("location"), name).toBeNull();
    }

    // A forged or foreign cookie is not a session: sign in again, and clear it.
    const forged = await app.request(
      `${origin}/`,
      {
        headers: {
          ...navigation,
          cookie:
            "__Host-dx_portal=v1.eyJ2IjoxfQ.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        },
      },
      bindings,
    );
    expect(forged.status).toBe(302);
    expect(setCookies(forged)).toContain(
      "__Host-dx_portal=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax",
    );

    // dx paths on a Portal host never reach the guest.
    const reserved = await app.request(
      `${origin}/__dx_portal/anything`,
      { headers: navigation },
      bindings,
    );
    expect(reserved.status).toBe(404);
    expect(execution.calls).toHaveLength(0);
    expect(execution.names).toHaveLength(0);
  });

  it("signs in through the app origin and relays with dx credentials stripped", async () => {
    const owner = await signUp("owner");
    const threadId = await createThread(owner.userId);
    const execution = fakeExecution((request) => {
      const path = new URL(request.url).pathname;
      if (path === "/proxy/websocket") {
        const pair = new WebSocketPair();
        pair[1].accept();
        return new Response(null, {
          status: 101,
          webSocket: pair[0],
          headers: { "sec-websocket-protocol": "vite-hmr" },
        });
      }
      const headers = new Headers({
        "content-type": "text/html",
        location: "http://localhost:5173/next?x=1",
      });
      headers.append("set-cookie", "guest=1; Path=/");
      headers.append("set-cookie", "__Host-dx_portal=planted; Path=/; Secure");
      return new Response("<p>guest</p>", { status: 200, headers });
    });
    const bindings = { ...baseBindings, THREAD_EXECUTION: execution.namespace };
    const origin = portalOriginFor(threadId, 5173);

    const handshake = await signInToPortal(
      bindings,
      threadId,
      5173,
      owner.cookie,
      "/app?x=1",
    );
    expect(handshake.callback.origin).toBe(origin);
    expect(handshake.callback.pathname).toBe("/__dx_portal/callback");
    expect(handshake.callback.searchParams.get("state")).toBeNull();
    expect(handshake.granted.headers.get("cache-control")).toBe("no-store");
    expect(handshake.completed.headers.get("location")).toBe("/app?x=1");
    const issued = setCookies(handshake.completed);
    expect(issued).toHaveLength(3);
    expect(issued[0]).toMatch(
      /^__Host-dx_portal=v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}; Max-Age=43200; Path=\/; HttpOnly; Secure; SameSite=Lax$/,
    );
    expect(issued[1]).toMatch(
      /^__Host-dx_portal_embed=v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}; Max-Age=43200; Path=\/; HttpOnly; Secure; SameSite=None; Partitioned$/,
    );
    expect(issued[2]).toBe(
      "__Host-dx_portal_state=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=None; Partitioned",
    );
    // Nothing reached the Thread while signing in.
    expect(execution.calls).toHaveLength(0);

    // The code works once.
    const replay = await app.request(
      handshake.callback.href,
      {
        headers: {
          cookie: `__Host-dx_portal_state=${handshake.state}`,
          ...navigation,
        },
      },
      bindings,
    );
    expect(replay.status).toBe(400);
    expect(await replay.text()).toContain("This sign-in link has expired");

    // A session for this port does not open another port of the Thread.
    const otherPort = await app.request(
      `${portalOriginFor(threadId, 3000)}/`,
      { headers: { ...navigation, cookie: handshake.cookie } },
      bindings,
    );
    expect(otherPort.status).toBe(302);
    expect(execution.calls).toHaveLength(0);

    const page = await app.request(
      `${origin}/app?x=1`,
      {
        headers: {
          ...navigation,
          "sec-fetch-site": "cross-site",
          cookie: `appsession=keep; ${handshake.cookie}; better-auth.session_token=leak; theme=dark`,
          "x-portal-user-id": "spoofed",
          "x-dx-proxy-port": "22",
          "x-dx-proxy-host": "evil.example",
          "x-forwarded-host": "evil.example",
          "cf-connecting-ip": "203.0.113.9",
          authorization: "Bearer app-token",
        },
      },
      bindings,
    );
    expect(page.status).toBe(200);
    expect(await page.text()).toBe("<p>guest</p>");
    expect(execution.names).toEqual([threadId]);
    const relayed = execution.calls[0];
    expect(relayed?.url).toBe("https://thread-execution/proxy/http");
    expect(relayed?.method).toBe("GET");
    const forwarded = relayed?.headers ?? new Headers();
    expect(Object.fromEntries(forwarded)).toMatchObject({
      "x-dx-thread-id": threadId,
      "x-dx-proxy-port": "5173",
      "x-dx-proxy-target": "/app?x=1",
      "x-dx-proxy-wake": "1",
      "x-dx-proxy-host": new URL(origin).host,
      "x-forwarded-host": new URL(origin).host,
      "x-forwarded-proto": "https",
      "x-forwarded-for": "203.0.113.9",
      "x-portal-authenticated": "yes",
      "x-portal-user-id": owner.userId,
      "x-portal-user-email": owner.email,
      "x-portal-user-name": encodeURIComponent("Portal owner Ü"),
      cookie: "appsession=keep; theme=dark",
      authorization: "Bearer app-token",
    });
    expect(forwarded.get("cf-connecting-ip")).toBeNull();

    // What the browser sees: only dx frames it, the guest cannot set dx
    // cookies, and a redirect to its loopback address points at the Portal.
    expect(page.headers.get("content-security-policy")).toBe(
      `frame-ancestors 'self' ${appOrigin}`,
    );
    expect(setCookies(page)).toEqual(["guest=1; Path=/"]);
    expect(page.headers.get("location")).toBe(`${origin}/next?x=1`);
    expect(page.headers.get("x-request-id")).toBeNull();

    const post = await app.request(
      `${origin}/api/items`,
      {
        method: "POST",
        body: JSON.stringify({ name: "item" }),
        headers: {
          "content-type": "application/json",
          "sec-fetch-site": "same-origin",
          "sec-fetch-mode": "cors",
          origin,
          cookie: handshake.cookie,
        },
      },
      bindings,
    );
    expect(post.status).toBe(200);
    expect(execution.calls[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ name: "item" }),
    });
    expect(execution.calls[1]?.headers.get("x-dx-proxy-target")).toBe(
      "/api/items",
    );

    // Sibling Portals share a registrable domain; their requests cannot ride
    // this Portal's cookie, and neither can another site's WebSocket.
    const siblingOrigin = portalOriginFor(threadId, 6006);
    for (const [name, headers] of [
      [
        "sibling fetch",
        {
          "sec-fetch-site": "same-site",
          "sec-fetch-mode": "cors",
          origin: siblingOrigin,
        },
      ],
      [
        "cross-site form",
        { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" },
      ],
      [
        "foreign WebSocket",
        {
          upgrade: "websocket",
          origin: siblingOrigin,
          "sec-websocket-key": "a",
        },
      ],
    ] as const) {
      const refused = await app.request(
        `${origin}/api/items`,
        {
          method: name === "cross-site form" ? "POST" : "GET",
          headers: { ...headers, cookie: handshake.cookie },
          ...(name === "cross-site form" ? { body: "x" } : {}),
        },
        bindings,
      );
      expect(refused.status, name).toBe(403);
    }
    expect(execution.calls).toHaveLength(2);

    const socket = await app.request(
      `${origin}/@vite/hmr?token=1`,
      {
        headers: {
          upgrade: "websocket",
          connection: "Upgrade",
          origin,
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          "sec-websocket-version": "13",
          "sec-websocket-protocol": "vite-hmr",
          "sec-fetch-mode": "websocket",
          "sec-fetch-site": "same-origin",
          cookie: `${handshake.cookie}; hmr=1`,
        },
      },
      bindings,
    );
    expect(socket.status).toBe(101);
    expect(socket.webSocket).not.toBeNull();
    socket.webSocket?.accept();
    socket.webSocket?.close();
    const upgrade = execution.calls[2];
    expect(upgrade?.url).toBe("https://thread-execution/proxy/websocket");
    expect(Object.fromEntries(upgrade?.headers ?? [])).toMatchObject({
      upgrade: "websocket",
      "x-dx-proxy-wake": "0",
      "x-dx-proxy-port": "5173",
      "x-dx-proxy-target": "/@vite/hmr?token=1",
      "sec-websocket-protocol": "vite-hmr",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      cookie: "hmr=1",
      origin,
    });
  });

  it("authorizes like the Terminal: owner or Contribute, active Thread", async () => {
    const owner = await signUp("rule-owner");
    const member = await signUp("rule-member");
    const outsider = await signUp("rule-outsider");
    const threadId = await createThread(owner.userId);
    const execution = fakeExecution();
    const bindings = { ...baseBindings, THREAD_EXECUTION: execution.namespace };
    const state = "s".repeat(43);
    const authorize = (
      cookie: string | undefined,
      params?: Record<string, string>,
    ) =>
      app.request(
        `${appOrigin}/v1/portal-auth/authorize?${new URLSearchParams({
          thread: threadId,
          port: "8080",
          return: "/",
          state,
          ...params,
        })}`,
        {
          headers: {
            ...navigation,
            ...(cookie === undefined ? {} : { cookie }),
          },
        },
        bindings,
      );

    const signedOut = await authorize(undefined);
    expect(signedOut.status).toBe(302);
    const signIn = new URL(signedOut.headers.get("location") ?? "");
    expect(signIn.origin).toBe(appOrigin);
    expect(signIn.pathname).toBe("/signin");
    expect(signIn.searchParams.get("next")).toMatch(
      /^\/v1\/portal-auth\/authorize\?thread=thr_/,
    );

    for (const [name, params] of [
      ["port 0", { port: "0" }],
      ["port 65536", { port: "65536" }],
      ["padded port", { port: "08080" }],
      ["scheme-relative return", { return: "//evil.example/" }],
      ["absolute return", { return: "https://evil.example/" }],
      ["backslash return", { return: "/\\evil.example" }],
      ["short state", { state: "short" }],
      ["bad thread", { thread: "thr_nope" }],
    ] as const) {
      const response = await authorize(owner.cookie, params);
      expect(response.status, name).toBe(400);
    }

    const foreign = await authorize(outsider.cookie);
    expect(foreign.status).toBe(404);
    expect(await foreign.text()).toContain("Thread not found");

    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, 'Portal team', ?, 1)",
      ).bind(`org-${threadId}`, `portal-${threadId.slice(-12)}`),
      env.DB.prepare(
        `INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES
           (?1 || '-o', ?1, ?2, 'owner', 1), (?1 || '-m', ?1, ?3, 'member', 2)`,
      ).bind(`org-${threadId}`, owner.userId, member.userId),
      env.DB.prepare(
        "UPDATE threads SET shared_workspace_id = ?, workspace_access = 'view' WHERE id = ?",
      ).bind(`org-${threadId}`, threadId),
    ]);
    const viewer = await authorize(member.cookie);
    expect(viewer.status).toBe(403);
    expect(await viewer.text()).toContain("Contribute access");

    await env.DB.prepare(
      "UPDATE threads SET workspace_access = 'contribute', contribute_until = ? WHERE id = ?",
    )
      .bind(new Date(Date.now() + 3_600_000).toISOString(), threadId)
      .run();
    const contributor = await authorize(member.cookie);
    expect(contributor.status).toBe(302);
    expect(contributor.headers.get("location")).toMatch(
      new RegExp(
        `^${portalOriginFor(threadId, 8080)}/__dx_portal/callback\\?code=`,
      ),
    );

    await env.DB.prepare(
      "UPDATE threads SET lifecycle_state = 'archived' WHERE id = ?",
    )
      .bind(threadId)
      .run();
    const archived = await authorize(owner.cookie);
    expect(archived.status).toBe(409);
    expect(await archived.text()).toContain("archived");
    expect(execution.calls).toHaveLength(0);
  });

  it("re-checks a stale session and closes the Portal once access ends", async () => {
    const owner = await signUp("revoked");
    const threadId = await createThread(owner.userId);
    const execution = fakeExecution();
    const bindings = { ...baseBindings, THREAD_EXECUTION: execution.namespace };
    const origin = portalOriginFor(threadId, 4000);
    await signInToPortal(bindings, threadId, 4000, owner.cookie);
    const key = await portalSigningKey(secret);
    if (key === undefined) throw new Error("setup");
    const latestSessionId = async () => {
      const id = await env.DB.prepare(
        'SELECT id FROM "session" WHERE "userId" = ? ORDER BY "createdAt" DESC LIMIT 1',
      )
        .bind(owner.userId)
        .first<string>("id");
      if (id === null) throw new Error("Expected a dx session.");
      return id;
    };
    const now = Math.floor(Date.now() / 1_000);
    // A Portal cookie whose access was last checked ten minutes ago.
    const staleCookie = async (name: string, sessionId: string) =>
      `${name}=${await encodePortalSession(key, {
        host: new URL(origin).host,
        userId: owner.userId,
        sessionId,
        issuedAt: now - 600,
        expiresAt: now + 3_600,
        checkedAt: now - 600,
      })}`;
    const visit = (cookie: string, headers: HeadersInit = navigation) =>
      app.request(
        `${origin}/`,
        { headers: { ...Object.fromEntries(new Headers(headers)), cookie } },
        bindings,
      );

    // Still allowed: the request goes on and the cookie is re-stamped.
    const rechecked = await visit(
      await staleCookie("__Host-dx_portal_embed", await latestSessionId()),
    );
    expect(rechecked.status).toBe(200);
    const restamped = setCookies(rechecked);
    expect(restamped).toHaveLength(1);
    expect(restamped[0]).toMatch(
      /^__Host-dx_portal_embed=v1\..+; Max-Age=36\d\d; Path=\/; HttpOnly; Secure; SameSite=None; Partitioned$/,
    );
    expect(execution.calls).toHaveLength(1);

    // Signed out of dx: the session the handshake ran under is gone.
    const signedOut = await visit(
      await staleCookie("__Host-dx_portal", "ses-signed-out"),
    );
    expect(signedOut.status).toBe(302);
    expect(setCookies(signedOut)).toContain(
      "__Host-dx_portal=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax",
    );

    // Archived: a stale cookie from a fresh, signed-in dx session is refused.
    const signIn = await app.request(
      `${appOrigin}/api/auth/sign-in/email`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: appOrigin,
          "cf-connecting-ip": "198.51.100.251",
        },
        body: JSON.stringify({
          email: owner.email,
          password: "portal-password-123",
        }),
      },
      baseBindings,
    );
    expect(signIn.status).toBe(200);
    await env.DB.prepare(
      "UPDATE threads SET lifecycle_state = 'archived' WHERE id = ?",
    )
      .bind(threadId)
      .run();
    const archivedCookie = await staleCookie(
      "__Host-dx_portal",
      await latestSessionId(),
    );
    const archived = await visit(archivedCookie);
    expect(archived.status).toBe(302);
    expect(new URL(archived.headers.get("location") ?? "").pathname).toBe(
      "/v1/portal-auth/authorize",
    );
    const asset = await visit(archivedCookie, {
      "sec-fetch-dest": "script",
      "sec-fetch-mode": "no-cors",
      "sec-fetch-site": "same-origin",
    });
    expect(asset.status).toBe(401);
    expect(execution.calls).toHaveLength(1);
  });

  it("explains relay failures with pages for documents and statuses otherwise", async () => {
    const owner = await signUp("errors");
    const threadId = await createThread(owner.userId);
    let next: Response = new Response(null);
    const execution = fakeExecution(() => next);
    const bindings = { ...baseBindings, THREAD_EXECUTION: execution.namespace };
    const origin = portalOriginFor(threadId, 5000);
    const { cookie } = await signInToPortal(
      bindings,
      threadId,
      5000,
      owner.cookie,
    );
    const relayFailure = (error: string, status: number) =>
      new Response("relay detail", {
        status,
        headers: { "x-dx-proxy-error": error },
      });
    const asDocument = { ...navigation, cookie };
    const asScript = {
      "sec-fetch-dest": "script",
      "sec-fetch-mode": "no-cors",
      "sec-fetch-site": "same-origin",
      cookie,
    };

    next = relayFailure("upstream-unreachable", 502);
    const unreachable = await app.request(
      `${origin}/`,
      { headers: asDocument },
      bindings,
    );
    expect(unreachable.status).toBe(502);
    const unreachableBody = await unreachable.text();
    expect(unreachableBody).toContain("Nothing is listening on port 5000");
    expect(unreachableBody).not.toContain("relay detail");
    expect(unreachable.headers.get("content-security-policy")).toContain(
      `frame-ancestors 'self' ${appOrigin}`,
    );
    next = relayFailure("upstream-unreachable", 502);
    const unreachableScript = await app.request(
      `${origin}/a.js`,
      { headers: asScript },
      bindings,
    );
    expect(unreachableScript.status).toBe(502);
    expect(await unreachableScript.text()).toBe("upstream-unreachable");

    next = relayFailure("workspace-unavailable", 503);
    const waking = await app.request(
      `${origin}/`,
      { headers: asDocument },
      bindings,
    );
    expect(waking.status).toBe(503);
    expect(waking.headers.get("retry-after")).toBe("2");
    const wakingBody = await waking.text();
    expect(wakingBody).toContain("Waking the workspace");
    expect(wakingBody).toContain("location.reload()");
    const nonce = /script-src 'nonce-([A-Za-z0-9_-]+)'/.exec(
      waking.headers.get("content-security-policy") ?? "",
    )?.[1];
    expect(wakingBody).toContain(`<script nonce="${nonce}">`);

    // A declared service that is still starting reloads like a wake.
    next = relayFailure("service-starting", 503);
    const starting = await app.request(
      `${origin}/`,
      { headers: asDocument },
      bindings,
    );
    expect(starting.status).toBe(503);
    const startingBody = await starting.text();
    expect(startingBody).toContain("Starting the server on port 5000");
    expect(startingBody).toContain("location.reload()");

    for (const [error, status] of [
      ["upstream-timeout", 504],
      ["upstream-reset", 502],
      ["invalid-response", 502],
      ["invalid-request", 400],
      ["too-many-streams", 503],
    ] as const) {
      next = relayFailure(error, status);
      const failed = await app.request(
        `${origin}/x.css`,
        { headers: asScript },
        bindings,
      );
      expect(failed.status, error).toBe(status);
      expect(await failed.text(), error).toBe(error);
    }

    // A guest that answers 502 itself is passed through untouched.
    next = new Response("guest bad gateway", { status: 502 });
    const guest = await app.request(
      `${origin}/`,
      { headers: asDocument },
      bindings,
    );
    expect(guest.status).toBe(502);
    expect(await guest.text()).toBe("guest bad gateway");

    // A relay that throws is unavailable, never a leaked error.
    const broken = {
      ...bindings,
      THREAD_EXECUTION: {
        idFromName: () => ({}),
        get: () => ({
          fetch: async () => {
            throw new Error("sandbox-secret");
          },
        }),
      } as unknown as DurableObjectNamespace,
    };
    const thrown = await app.request(
      `${origin}/`,
      { headers: asDocument },
      broken,
    );
    expect(thrown.status).toBe(503);
    expect(await thrown.text()).not.toContain("sandbox-secret");
  });

  it("lists guest ports as Portal URLs without waking the workspace", async () => {
    const owner = await signUp("ports");
    const outsider = await signUp("ports-outsider");
    const threadId = await createThread(owner.userId);
    let next: Response = new Response(null);
    const execution = fakeExecution(() => next);
    const bindings = { ...baseBindings, THREAD_EXECUTION: execution.namespace };
    const list = (cookie: string, overrides: Partial<Bindings> = {}) =>
      app.request(
        `${appOrigin}/v1/threads/${threadId}/portals`,
        { headers: { cookie } },
        { ...bindings, ...overrides },
      );

    next = Response.json({
      ports: [
        { port: 8080, address: "0.0.0.0" },
        { port: 5173, address: "127.0.0.1" },
        { port: 5173, address: "::1" },
        { port: 0, address: "0.0.0.0" },
      ],
    });
    const running = await list(owner.cookie);
    expect(running.status).toBe(200);
    expect(await running.json()).toEqual({
      status: "success",
      data: {
        workspace: "running",
        portals: [
          { port: 5173, url: `${portalOriginFor(threadId, 5173)}/` },
          { port: 8080, url: `${portalOriginFor(threadId, 8080)}/` },
        ],
        publicLinks: [],
        canPublish: true,
      },
    });
    expect(execution.calls[0]?.url).toBe(
      "https://thread-execution/proxy/ports",
    );
    expect(execution.calls[0]?.headers.get("x-dx-proxy-wake")).toBe("0");
    expect(execution.calls[0]?.headers.get("x-dx-thread-id")).toBe(threadId);

    next = new Response(null, {
      status: 503,
      headers: { "x-dx-proxy-error": "workspace-paused" },
    });
    expect(await (await list(owner.cookie)).json()).toMatchObject({
      data: { workspace: "paused", portals: [] },
    });

    expect((await list(outsider.cookie)).status).toBe(404);
    expect(
      (await list(owner.cookie, { DX_PORTAL_DOMAIN: undefined })).status,
    ).toBe(404);
    expect(execution.calls).toHaveLength(2);

    const settings = await app.request(
      `${appOrigin}/v1/settings/personal`,
      { headers: { cookie: owner.cookie } },
      bindings,
    );
    expect(settings.status).toBe(200);
    expect(await settings.json()).toMatchObject({ data: { portalDomain } });
  });

  it("never wakes a paused workspace through the real Thread execution object", async () => {
    const owner = await signUp("real-object");
    const threadId = await createThread(owner.userId);
    const bindings = {
      ...baseBindings,
      THREAD_EXECUTION: env.THREAD_EXECUTION,
    };
    const origin = portalOriginFor(threadId, 5173);
    const listed = await app.request(
      `${appOrigin}/v1/threads/${threadId}/portals`,
      { headers: { cookie: owner.cookie } },
      bindings,
    );
    expect(await listed.json()).toEqual({
      status: "success",
      data: {
        workspace: "paused",
        portals: [],
        publicLinks: [],
        canPublish: true,
      },
    });
    const { cookie } = await signInToPortal(
      bindings,
      threadId,
      5173,
      owner.cookie,
    );
    const socket = await app.request(
      `${origin}/@vite/hmr`,
      {
        headers: {
          upgrade: "websocket",
          origin,
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          "sec-websocket-version": "13",
          "sec-fetch-site": "same-origin",
          cookie,
        },
      },
      bindings,
    );
    expect(socket.status).toBe(503);
    expect(await socket.text()).toBe("workspace-paused");
  });

  it("serves the same handler from the standalone Portal Worker", async () => {
    const execution = fakeExecution();
    const bindings = { ...baseBindings, THREAD_EXECUTION: execution.namespace };
    const threadId = "thr_00000000-0000-4000-8000-0000000000a9";
    const redirect = await portalWorker.fetch(
      new Request(`${portalOriginFor(threadId, 3000)}/`, {
        headers: navigation,
      }),
      bindings,
    );
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toContain(
      `${appOrigin}/v1/portal-auth/authorize?`,
    );
    const elsewhere = await portalWorker.fetch(
      new Request("https://dx.test/"),
      bindings,
    );
    expect(elsewhere.status).toBe(404);
    const local = await portalWorker.fetch(
      new Request(`http://t-${threadId.slice(4)}-p3000.localhost:5174/`, {
        headers: navigation,
      }),
      { ...bindings, DX_PORTAL_DOMAIN: "localhost:5174" },
    );
    expect(local.status).toBe(302);
    // https deployments upgrade a plain-HTTP visit before anything else.
    const insecure = await portalWorker.fetch(
      new Request(`http://t-${threadId.slice(4)}-p3000.${portalDomain}/x`),
      bindings,
    );
    expect(insecure.status).toBe(308);
    expect(insecure.headers.get("location")).toBe(
      `${portalOriginFor(threadId, 3000)}/x`,
    );
    expect(execution.calls).toHaveLength(0);
  });
});

describe("Public Portal links in workerd", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const publicLinkUrl = (threadId: string, port: number | string) =>
    `${appOrigin}/v1/threads/${threadId}/portals/${port}/public`;
  const publish = (
    bindings: Bindings,
    cookie: string,
    threadId: string,
    port: number | string,
    duration: unknown = "1h",
  ) =>
    app.request(
      publicLinkUrl(threadId, port),
      {
        method: "PUT",
        headers: {
          cookie,
          origin: appOrigin,
          "content-type": "application/json",
        },
        body: JSON.stringify({ duration }),
      },
      bindings,
    );
  const revoke = (
    bindings: Bindings,
    cookie: string,
    threadId: string,
    port: number,
  ) =>
    app.request(
      publicLinkUrl(threadId, port),
      { method: "DELETE", headers: { cookie, origin: appOrigin } },
      bindings,
    );
  const list = (bindings: Bindings, cookie: string, threadId: string) =>
    app.request(
      `${appOrigin}/v1/threads/${threadId}/portals`,
      { headers: { cookie } },
      bindings,
    );
  const asScript = {
    "sec-fetch-dest": "script",
    "sec-fetch-mode": "no-cors",
    "sec-fetch-site": "same-origin",
  };
  const visit = (
    bindings: Bindings,
    url: string,
    headers: Record<string, string> = navigation,
  ) => app.request(url, { headers }, bindings);
  /** The first-visit page's Continue button, as the browser posts it. */
  const acknowledge = (
    bindings: Bindings,
    origin: string,
    body: string,
    from = origin,
    site = from === origin ? "same-origin" : "cross-site",
  ) =>
    app.request(
      `${origin}/__dx_portal/public`,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: from,
          "sec-fetch-site": site,
          "sec-fetch-mode": "navigate",
          "sec-fetch-dest": "document",
        },
        body,
      },
      bindings,
    );
  const acknowledgedCookie = async (bindings: Bindings, origin: string) => {
    const response = await acknowledge(bindings, origin, "return=%2F");
    const value = cookieValue(response, "__Host-dx_portal_public");
    if (value === undefined) throw new Error("Expected an acknowledgement.");
    return `__Host-dx_portal_public=${value}`;
  };
  const portalHeaders = (headers: Headers | undefined) =>
    [...(headers ?? new Headers()).keys()].filter((name) =>
      name.startsWith("x-portal-"),
    );

  it("serves one public port to anonymous visitors, without identity, after a first-visit page", async () => {
    const owner = await signUp("public-owner");
    const threadId = await createThread(owner.userId);
    const execution = fakeExecution();
    const bindings = { ...baseBindings, THREAD_EXECUTION: execution.namespace };
    const origin = portalOriginFor(threadId, 5173);
    const otherOrigin = portalOriginFor(threadId, 3000);

    // Private: anonymous visitors are sent to sign in and never reach the Thread.
    expect((await visit(bindings, `${origin}/`)).status).toBe(302);
    expect((await visit(bindings, `${origin}/a.js`, asScript)).status).toBe(
      401,
    );
    expect(execution.calls).toHaveLength(0);

    const published = await publish(bindings, owner.cookie, threadId, 5173);
    expect(published.status).toBe(200);
    const link = (await published.json()) as {
      data: { port: number; url: string; expiresAt: string };
    };
    expect(link.data.port).toBe(5173);
    expect(link.data.url).toBe(`${origin}/`);
    expect(
      Math.abs(Date.parse(link.data.expiresAt) - (Date.now() + 3_600_000)),
    ).toBeLessThan(10_000);

    // The first document shows the first-visit page, not the guest.
    const notice = await visit(bindings, `${origin}/app?x=1`);
    expect(notice.status).toBe(200);
    const noticeBody = await notice.text();
    expect(noticeBody).toContain("Public preview");
    expect(noticeBody).toContain(new URL(origin).host);
    expect(noticeBody).toContain('name="return" value="/app?x=1"');
    expect(noticeBody).toContain(
      'href="/__dx_portal/sign-in?return=%2Fapp%3Fx%3D1"',
    );
    expect(notice.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(notice.headers.get("cache-control")).toBe("no-store");
    expect(execution.calls).toHaveLength(0);

    // Another site cannot press Continue for the visitor.
    const forged = await acknowledge(
      bindings,
      origin,
      "return=%2Fapp",
      "https://evil.example",
    );
    expect(forged.status).toBe(403);
    expect(setCookies(forged)).toEqual([]);
    // Continue goes back to a path on this Portal, never elsewhere.
    const offsite = await acknowledge(
      bindings,
      origin,
      "return=%2F%2Fevil.example%2F",
    );
    expect(offsite.status).toBe(303);
    expect(offsite.headers.get("location")).toBe("/");

    // The browser posts Continue from the notice page with the Origin its
    // referrer policy allows: `null` under `no-referrer`.
    const accepted = await acknowledge(
      bindings,
      origin,
      `return=${encodeURIComponent("/app?x=1")}`,
      notice.headers.get("referrer-policy") === "no-referrer" ? "null" : origin,
      "same-origin",
    );
    expect(accepted.status).toBe(303);
    expect(accepted.headers.get("location")).toBe("/app?x=1");
    const issued = setCookies(accepted);
    expect(issued).toHaveLength(1);
    // An hour, or the link's remaining life when that is shorter (a second
    // may have passed since it was published).
    expect(issued[0]).toMatch(
      /^__Host-dx_portal_public=p1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}; Max-Age=(?:3600|359\d); Path=\/; HttpOnly; Secure; SameSite=Lax$/,
    );
    const acknowledged = `__Host-dx_portal_public=${cookieValue(accepted, "__Host-dx_portal_public")}`;

    // Acknowledged: the guest answers, with no identity and nothing spoofed.
    const page = await visit(bindings, `${origin}/app?x=1`, {
      ...navigation,
      cookie: `appsession=keep; ${acknowledged}`,
      "x-portal-authenticated": "yes",
      "x-portal-user-id": "spoofed",
      "x-portal-user-email": "spoofed@example.com",
    });
    expect(page.status).toBe(200);
    expect(await page.text()).toBe("guest says hi");
    expect(execution.calls).toHaveLength(1);
    const relayed = execution.calls[0]?.headers;
    expect(portalHeaders(relayed)).toEqual([]);
    expect(relayed?.get("cookie")).toBe("appsession=keep");
    expect(relayed?.get("x-dx-proxy-port")).toBe("5173");
    expect(relayed?.get("x-dx-proxy-target")).toBe("/app?x=1");
    // An authorized request: it may wake the workspace.
    expect(relayed?.get("x-dx-proxy-wake")).toBe("1");

    // Subresources and API calls need no acknowledgement.
    const script = await visit(bindings, `${origin}/a.js`, asScript);
    expect(script.status).toBe(200);
    expect(portalHeaders(execution.calls[1]?.headers)).toEqual([]);
    expect(execution.calls).toHaveLength(2);

    // Only that port: the Thread's other ports stay private.
    expect(
      (
        await visit(bindings, `${otherOrigin}/`, {
          ...navigation,
          cookie: acknowledged,
        })
      ).status,
    ).toBe(302);
    expect(
      (await visit(bindings, `${otherOrigin}/a.js`, asScript)).status,
    ).toBe(401);
    expect(execution.calls).toHaveLength(2);

    // Members keep signing in, from the page's link or inside the dx app's
    // Preview frame, and keep their identity headers.
    const framed = await visit(bindings, `${origin}/`, {
      ...navigation,
      "sec-fetch-dest": "iframe",
      "sec-fetch-site": "cross-site",
    });
    expect(framed.status).toBe(302);
    expect(new URL(framed.headers.get("location") ?? "").pathname).toBe(
      "/v1/portal-auth/authorize",
    );
    const member = await signInToPortal(
      bindings,
      threadId,
      5173,
      owner.cookie,
      "/app",
      "/__dx_portal/sign-in?return=%2Fapp",
    );
    expect(member.completed.headers.get("location")).toBe("/app");
    const signedIn = await visit(bindings, `${origin}/app`, {
      ...navigation,
      cookie: member.cookie,
    });
    expect(signedIn.status).toBe(200);
    expect(Object.fromEntries(execution.calls[2]?.headers ?? [])).toMatchObject(
      {
        "x-portal-authenticated": "yes",
        "x-portal-user-id": owner.userId,
      },
    );
  });

  it("closes a public port on revocation, expiry, and archive", async () => {
    const owner = await signUp("public-revoke");
    const threadId = await createThread(owner.userId);
    const execution = fakeExecution();
    const bindings = { ...baseBindings, THREAD_EXECUTION: execution.namespace };
    const origin = portalOriginFor(threadId, 4100);

    // Revocation takes effect on the next request.
    expect((await publish(bindings, owner.cookie, threadId, 4100)).status).toBe(
      200,
    );
    const firstAcknowledgement = await acknowledgedCookie(bindings, origin);
    expect((await visit(bindings, `${origin}/a.js`, asScript)).status).toBe(
      200,
    );
    const revoked = await revoke(bindings, owner.cookie, threadId, 4100);
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({
      status: "success",
      data: { port: 4100 },
    });
    expect((await visit(bindings, `${origin}/a.js`, asScript)).status).toBe(
      401,
    );
    expect(
      (
        await visit(bindings, `${origin}/`, {
          ...navigation,
          cookie: firstAcknowledgement,
        })
      ).status,
    ).toBe(302);
    expect(execution.calls).toHaveLength(1);
    expect((await revoke(bindings, owner.cookie, threadId, 4100)).status).toBe(
      200,
    );

    // A new link asks again: the old acknowledgement was for the old link.
    expect((await publish(bindings, owner.cookie, threadId, 4100)).status).toBe(
      200,
    );
    const again = await visit(bindings, `${origin}/`, {
      ...navigation,
      cookie: firstAcknowledgement,
    });
    expect(again.status).toBe(200);
    expect(await again.text()).toContain("Public preview");
    expect(execution.calls).toHaveLength(1);

    // Expiry is exact: one second past the hour, the port is private.
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 3_600_000 + 1_000);
    expect((await visit(bindings, `${origin}/a.js`, asScript)).status).toBe(
      401,
    );
    expect(await (await list(bindings, owner.cookie, threadId)).json()).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({ publicLinks: [] }),
      }),
    );
    vi.useRealTimers();
    expect(
      execution.calls.filter(({ url }) => url.endsWith("/proxy/http")),
    ).toHaveLength(1);

    // Archiving revokes for good, within the per-isolate cache window.
    const archivedThread = await createThread(owner.userId);
    const archivedOrigin = portalOriginFor(archivedThread, 4200);
    expect(
      (await publish(bindings, owner.cookie, archivedThread, 4200, "1d"))
        .status,
    ).toBe(200);
    const before = execution.calls.length;
    expect(
      (await visit(bindings, `${archivedOrigin}/a.js`, asScript)).status,
    ).toBe(200);
    await env.DB.prepare(
      "UPDATE threads SET lifecycle_state = 'archived' WHERE id = ?",
    )
      .bind(archivedThread)
      .run();
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
    vi.setSystemTime(Date.now() + PUBLIC_LINK_CACHE_MS + 1);
    expect(
      (await visit(bindings, `${archivedOrigin}/a.js`, asScript)).status,
    ).toBe(401);
    expect((await visit(bindings, `${archivedOrigin}/`)).status).toBe(302);
    vi.useRealTimers();
    expect(execution.calls).toHaveLength(before + 1);
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS links FROM portal_public_links WHERE thread_id = ?",
      )
        .bind(archivedThread)
        .first<number>("links"),
    ).toBe(0);
    const refused = await publish(bindings, owner.cookie, archivedThread, 4200);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      data: { code: "THREAD_ARCHIVED" },
    });
    // Unarchiving does not bring the link back.
    await env.DB.prepare(
      "UPDATE threads SET lifecycle_state = 'active' WHERE id = ?",
    )
      .bind(archivedThread)
      .run();
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
    vi.setSystemTime(Date.now() + PUBLIC_LINK_CACHE_MS + 1);
    expect(
      (await visit(bindings, `${archivedOrigin}/a.js`, asScript)).status,
    ).toBe(401);
    vi.useRealTimers();
    expect(execution.calls).toHaveLength(before + 1);
  });

  it("lets only the owner make ports public, at most three at once", async () => {
    const owner = await signUp("public-cap-owner");
    const member = await signUp("public-cap-member");
    const outsider = await signUp("public-cap-outsider");
    const threadId = await createThread(owner.userId);
    const execution = fakeExecution();
    const bindings = { ...baseBindings, THREAD_EXECUTION: execution.namespace };
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, 'Public team', ?, 1)",
      ).bind(`org-${threadId}`, `public-${threadId.slice(-12)}`),
      env.DB.prepare(
        `INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES
           (?1 || '-o', ?1, ?2, 'owner', 1), (?1 || '-m', ?1, ?3, 'member', 2)`,
      ).bind(`org-${threadId}`, owner.userId, member.userId),
      env.DB.prepare(
        "UPDATE threads SET shared_workspace_id = ?, workspace_access = 'contribute', contribute_until = ? WHERE id = ?",
      ).bind(
        `org-${threadId}`,
        new Date(Date.now() + 3_600_000).toISOString(),
        threadId,
      ),
    ]);

    // A contributor can open Portals but not publish them.
    for (const response of [
      await publish(bindings, member.cookie, threadId, 3001),
      await revoke(bindings, member.cookie, threadId, 3001),
    ]) {
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        data: { code: "PORTAL_PUBLIC_OWNER_ONLY" },
      });
    }
    expect(
      (await publish(bindings, outsider.cookie, threadId, 3001)).status,
    ).toBe(404);
    for (const [port, duration] of [
      [3001, "2h"],
      [3001, 3_600],
      ["0", "1h"],
      ["080", "1h"],
      ["65536", "1h"],
    ] as const) {
      const invalid = await publish(
        bindings,
        owner.cookie,
        threadId,
        port,
        duration,
      );
      expect(invalid.status, `${port} ${duration}`).toBe(400);
      expect(await invalid.json()).toMatchObject({
        data: { code: "INVALID_REQUEST" },
      });
    }

    for (const [port, duration] of [
      [3001, "1h"],
      [3002, "1d"],
      [3003, "7d"],
    ] as const)
      expect(
        (await publish(bindings, owner.cookie, threadId, port, duration))
          .status,
      ).toBe(200);
    const capped = await publish(bindings, owner.cookie, threadId, 3004);
    expect(capped.status).toBe(409);
    expect(await capped.json()).toMatchObject({
      data: { code: "PORTAL_PUBLIC_LIMIT" },
    });
    // Changing a public port's lifetime is not a new port.
    const extended = await publish(
      bindings,
      owner.cookie,
      threadId,
      3001,
      "1d",
    );
    expect(extended.status).toBe(200);
    const extendedUntil = Date.parse(
      ((await extended.json()) as { data: { expiresAt: string } }).data
        .expiresAt,
    );
    expect(Math.abs(extendedUntil - (Date.now() + 86_400_000))).toBeLessThan(
      10_000,
    );
    expect((await revoke(bindings, owner.cookie, threadId, 3002)).status).toBe(
      200,
    );
    expect((await publish(bindings, owner.cookie, threadId, 3004)).status).toBe(
      200,
    );

    // Contributors see what is public; only the owner may change it.
    const seen = (await (
      await list(bindings, member.cookie, threadId)
    ).json()) as {
      data: {
        canPublish: boolean;
        publicLinks: ReadonlyArray<{ port: number; url: string }>;
      };
    };
    expect(seen.data.canPublish).toBe(false);
    expect(seen.data.publicLinks.map(({ port }) => port)).toEqual([
      3001, 3003, 3004,
    ]);
    expect(seen.data.publicLinks[0]?.url).toBe(
      `${portalOriginFor(threadId, 3001)}/`,
    );
    expect(
      (await (await list(bindings, owner.cookie, threadId)).json()) as unknown,
    ).toMatchObject({ data: { canPublish: true } });
    expect(execution.calls.map(({ url }) => url)).not.toContain(
      "https://thread-execution/proxy/http",
    );
  });

  it("rate-limits anonymous traffic per public host, never members", async () => {
    const owner = await signUp("public-rate");
    const threadId = await createThread(owner.userId);
    const execution = fakeExecution();
    const bindings = { ...baseBindings, THREAD_EXECUTION: execution.namespace };
    const origin = portalOriginFor(threadId, 4300);
    const otherOrigin = portalOriginFor(threadId, 4301);
    expect((await publish(bindings, owner.cookie, threadId, 4300)).status).toBe(
      200,
    );
    expect((await publish(bindings, owner.cookie, threadId, 4301)).status).toBe(
      200,
    );
    // A dev server's first page load fits in the burst. The clock stands
    // still, so nothing refills meanwhile.
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
    for (let batch = 0; batch < 10; batch += 1) {
      const statuses = await Promise.all(
        Array.from({ length: 100 }, async (_, index) => {
          const response = await visit(
            bindings,
            `${origin}/module-${batch}-${index}.js`,
            asScript,
          );
          await response.body?.cancel();
          return response.status;
        }),
      );
      expect(new Set(statuses)).toEqual(new Set([200]));
    }
    const limited = await visit(bindings, `${origin}/more.js`, asScript);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("5");
    expect(await limited.text()).toBe("Too many requests");
    expect(execution.calls).toHaveLength(1_000);
    // Then about 20 requests a second.
    vi.setSystemTime(Date.now() + 1_000);
    for (let index = 0; index < 20; index += 1)
      expect(
        (await visit(bindings, `${origin}/next-${index}.js`, asScript)).status,
      ).toBe(200);
    expect((await visit(bindings, `${origin}/over.js`, asScript)).status).toBe(
      429,
    );
    expect(execution.calls).toHaveLength(1_020);

    // Another public host has its own budget, and members are not counted.
    expect(
      (await visit(bindings, `${otherOrigin}/a.js`, asScript)).status,
    ).toBe(200);
    const { cookie } = await signInToPortal(
      bindings,
      threadId,
      4300,
      owner.cookie,
      "/",
      "/__dx_portal/sign-in?return=%2F",
    );
    expect(
      (
        await visit(bindings, `${origin}/more.js`, {
          ...asScript,
          cookie,
        })
      ).status,
    ).toBe(200);
    expect(execution.calls).toHaveLength(1_022);
  });
});

describe("Portal hardening in workerd", () => {
  const scriptFetch = {
    "sec-fetch-dest": "script",
    "sec-fetch-mode": "no-cors",
    "sec-fetch-site": "same-origin",
  };

  it("turns Portals off when their domain is on the app's site", async () => {
    const execution = fakeExecution();
    const threadId = "thr_00000000-0000-4000-8000-0000000000b1";
    const host = (domain: string) =>
      `https://t-${threadId.slice(4)}-p80.${domain}/`;
    const bindingsFor = (domain: string) => ({
      ...baseBindings,
      THREAD_EXECUTION: execution.namespace,
      DX_AUTH_URL: "https://dx.example.com",
      DX_AUTH_TRUSTED_ORIGINS: "https://dx.example.com",
      DX_PORTAL_DOMAIN: domain,
    });
    // A sibling under example.com could set Domain=example.com cookies that
    // dx reads, and would be same-site for dx's Lax cookies.
    for (const domain of [
      "portals.example.com",
      "example.com",
      "p.dx.example.com",
    ]) {
      const response = await portalWorker.fetch(
        new Request(host(domain), { headers: navigation }),
        bindingsFor(domain),
      );
      expect(response.status, domain).toBe(404);
      expect(await response.text(), domain).toBe("Not found");
    }
    // A separate registrable domain serves Portals.
    const separate = await portalWorker.fetch(
      new Request(host("dx-portals.com"), { headers: navigation }),
      bindingsFor("dx-portals.com"),
    );
    expect(separate.status).toBe(302);
    expect(execution.calls).toHaveLength(0);
  });

  it("passes Core's own localhost host to the app in local development", async () => {
    const local = {
      ...baseBindings,
      DX_PORTAL_DOMAIN: "localhost:5174",
      DX_AUTH_URL: "http://localhost:5173",
      DX_AUTH_TRUSTED_ORIGINS: "http://localhost:5173",
    };
    const health = await app.request(
      "http://localhost:5174/healthz",
      {},
      local,
    );
    expect(health.status).toBe(200);
    const portal = await app.request(
      "http://t-00000000-0000-4000-8000-0000000000b2-p3000.localhost:5174/",
      { headers: navigation },
      local,
    );
    expect(portal.status).toBe(302);
  });

  it("keeps guest cookies on their own Portal host and bounds them", async () => {
    const owner = await signUp("cookies");
    const threadId = await createThread(owner.userId);
    const execution = fakeExecution(() => {
      const headers = new Headers({ "content-type": "text/plain" });
      headers.append("set-cookie", `wide=1; Domain=${portalDomain}; Path=/`);
      headers.append(
        "set-cookie",
        `wider=2; Path=/; domain = .${portalDomain}; Secure`,
      );
      headers.append("set-cookie", "own=3; Path=/; HttpOnly");
      return new Response("ok", { headers });
    });
    const bindings = { ...baseBindings, THREAD_EXECUTION: execution.namespace };
    const origin = portalOriginFor(threadId, 5300);
    const { cookie } = await signInToPortal(
      bindings,
      threadId,
      5300,
      owner.cookie,
    );
    const page = await app.request(
      `${origin}/`,
      { headers: { ...navigation, cookie } },
      bindings,
    );
    expect(page.status).toBe(200);
    expect(setCookies(page)).toEqual([
      "wide=1; Path=/",
      "wider=2; Path=/; Secure",
      "own=3; Path=/; HttpOnly",
    ]);
    expect(execution.calls).toHaveLength(1);

    // A browser holding more guest cookies than a server takes is told to
    // drop them, on this host and on the Portal domain.
    const pile = Array.from(
      { length: 20 },
      (_, index) => `bomb${index}=${"x".repeat(500)}`,
    ).join("; ");
    const bombed = await app.request(
      `${origin}/`,
      { headers: { ...navigation, cookie: `${cookie}; ${pile}` } },
      bindings,
    );
    expect(bombed.status).toBe(431);
    expect(await bombed.text()).toContain("too many cookies");
    const clears = setCookies(bombed);
    expect(clears).toContain("bomb0=; Max-Age=0; Path=/");
    expect(clears).toContain(
      `bomb0=; Max-Age=0; Path=/; Domain=${portalDomain}`,
    );
    expect(clears.some((value) => value.startsWith("__Host-dx_portal"))).toBe(
      false,
    );
    expect(execution.calls).toHaveLength(1);
  });

  it("strips identity headers however they are spelled and encodes values unambiguously", async () => {
    const owner = await signUp("encoding", "Ada 100% done");
    const threadId = await createThread(owner.userId);
    const execution = fakeExecution();
    const bindings = { ...baseBindings, THREAD_EXECUTION: execution.namespace };
    const { cookie } = await signInToPortal(
      bindings,
      threadId,
      5400,
      owner.cookie,
    );
    const page = await app.request(
      `${portalOriginFor(threadId, 5400)}/`,
      {
        headers: {
          ...navigation,
          cookie,
          x_portal_user_id: "spoofed",
          X_Portal_Authenticated: "yes",
          x_forwarded_host: "evil.example",
          x_dx_proxy_port: "22",
          cf_connecting_ip: "203.0.113.1",
        },
      },
      bindings,
    );
    expect(page.status).toBe(200);
    const forwarded = execution.calls[0]?.headers ?? new Headers();
    const names = [...forwarded.keys()];
    expect(names.filter((name) => name.includes("_"))).toEqual([]);
    expect(forwarded.get("x-portal-user-id")).toBe(owner.userId);
    expect(forwarded.get("x-portal-user-name")).toBe("Ada%20100%25%20done");
    expect(decodeURIComponent(forwarded.get("x-portal-user-name") ?? "")).toBe(
      "Ada 100% done",
    );
    expect(forwarded.get("x-portal-user-email")).toBe(owner.email);
    expect(forwarded.get("x-forwarded-host")).toBe(
      new URL(portalOriginFor(threadId, 5400)).host,
    );
  });

  it("signs in a user whose name is longer than a cookie carries", async () => {
    const long = "N".repeat(700);
    const owner = await signUp("long-name", long);
    const threadId = await createThread(owner.userId);
    const execution = fakeExecution();
    const bindings = { ...baseBindings, THREAD_EXECUTION: execution.namespace };
    const { cookie } = await signInToPortal(
      bindings,
      threadId,
      5500,
      owner.cookie,
    );
    const page = await app.request(
      `${portalOriginFor(threadId, 5500)}/`,
      { headers: { ...navigation, cookie } },
      bindings,
    );
    // Not another trip to sign-in: the session decodes.
    expect(page.status).toBe(200);
    expect(execution.calls[0]?.headers.get("x-portal-user-name")).toBe(
      "N".repeat(512),
    );
  });

  it("checks the dx session itself, not Better Auth's cached copy, before minting a code", async () => {
    const owner = await signUp("revoked-cache");
    const threadId = await createThread(owner.userId);
    const bindings = {
      ...baseBindings,
      THREAD_EXECUTION: fakeExecution().namespace,
    };
    const authorize = () =>
      app.request(
        `${appOrigin}/v1/portal-auth/authorize?${new URLSearchParams({
          thread: threadId,
          port: "8080",
          return: "/",
          state: "s".repeat(43),
        })}`,
        { headers: { ...navigation, cookie: owner.cachedCookie } },
        bindings,
      );
    const before = await authorize();
    expect(before.status).toBe(302);
    expect(before.headers.get("location")).toContain("/__dx_portal/callback");
    // Signed out elsewhere: the session row is gone, the cached copy is not.
    await env.DB.prepare('DELETE FROM "session" WHERE "userId" = ?')
      .bind(owner.userId)
      .run();
    const after = await authorize();
    expect(after.status).toBe(302);
    expect(new URL(after.headers.get("location") ?? "").pathname).toBe(
      "/signin",
    );
  });

  it("fails closed with a page when D1 fails, even in the standalone Worker", async () => {
    const execution = fakeExecution();
    const failing = {
      prepare: () => {
        throw new Error("D1_ERROR: database unavailable");
      },
      batch: async () => {
        throw new Error("D1_ERROR: database unavailable");
      },
    } as unknown as D1Database;
    const bindings = {
      ...baseBindings,
      DB: failing,
      THREAD_EXECUTION: execution.namespace,
    };
    const origin = portalOriginFor(
      "thr_00000000-0000-4000-8000-0000000000b3",
      3000,
    );
    const key = await portalSigningKey(secret);
    if (key === undefined) throw new Error("setup");
    const now = Math.floor(Date.now() / 1_000);
    const stale = `__Host-dx_portal=${await encodePortalSession(key, {
      host: new URL(origin).host,
      userId: "user-b3",
      sessionId: "session-b3",
      issuedAt: now - 600,
      expiresAt: now + 3_600,
      checkedAt: now - 600,
    })}`;
    for (const [name, request] of [
      // The public-link lookup.
      ["anonymous", new Request(`${origin}/`, { headers: navigation })],
      // The access re-check.
      [
        "stale session",
        new Request(`${origin}/`, {
          headers: { ...navigation, cookie: stale },
        }),
      ],
      // Redeeming a sign-in code.
      [
        "callback",
        new Request(`${origin}/__dx_portal/callback?code=${"c".repeat(43)}`, {
          headers: {
            ...navigation,
            cookie: `__Host-dx_portal_state=${"s".repeat(43)}`,
          },
        }),
      ],
    ] as const) {
      const response = await portalWorker.fetch(request, bindings);
      expect(response.status, name).toBe(503);
      const body = await response.text();
      expect(body, name).toContain("This Portal is unavailable");
      expect(body, name).not.toContain("D1_ERROR");
    }
    expect(execution.calls).toHaveLength(0);
  });

  it("asks browsers without Fetch Metadata to prove a session request is from the Portal", async () => {
    const owner = await signUp("no-metadata");
    const threadId = await createThread(owner.userId);
    const execution = fakeExecution();
    const bindings = { ...baseBindings, THREAD_EXECUTION: execution.namespace };
    const origin = portalOriginFor(threadId, 5600);
    const sibling = portalOriginFor(threadId, 5601);
    const { cookie } = await signInToPortal(
      bindings,
      threadId,
      5600,
      owner.cookie,
    );
    const send = (init: RequestInit & { headers: Record<string, string> }) =>
      app.request(
        `${origin}/api/data`,
        { ...init, headers: { ...init.headers, cookie } },
        bindings,
      );
    for (const [name, init, status] of [
      // A sibling Portal's <img>/<script>, or one with no referrer at all.
      ["subresource, no referrer", { headers: { accept: "*/*" } }, 403],
      [
        "subresource from a sibling",
        { headers: { accept: "*/*", referer: `${sibling}/` } },
        403,
      ],
      [
        "form post from a sibling",
        { method: "POST", body: "x", headers: { origin: sibling } },
        403,
      ],
      // The Portal's own requests, and a link to a document.
      [
        "subresource from the Portal",
        { headers: { accept: "*/*", referer: `${origin}/page` } },
        200,
      ],
      [
        "fetch from the Portal",
        { method: "POST", body: "x", headers: { origin } },
        200,
      ],
      ["document link", { headers: { accept: "text/html" } }, 200],
    ] as const) {
      const response = await send(init);
      expect(response.status, name).toBe(status);
      await response.body?.cancel();
    }
    expect(execution.calls).toHaveLength(3);
    // Without a session nothing rides; a plain client still signs in.
    expect((await app.request(`${origin}/`, {}, bindings)).status).toBe(302);
    expect(
      (
        await app.request(
          `${origin}/a.js`,
          { headers: { ...scriptFetch, cookie } },
          bindings,
        )
      ).status,
    ).toBe(200);
  });

  it("wakes a paused workspace to list its ports only when asked", async () => {
    const owner = await signUp("wake");
    const threadId = await createThread(owner.userId);
    const execution = fakeExecution(() =>
      Response.json({ ports: [{ port: 5173, address: "0.0.0.0" }] }),
    );
    const bindings = { ...baseBindings, THREAD_EXECUTION: execution.namespace };
    const woken = await app.request(
      `${appOrigin}/v1/threads/${threadId}/portals/wake`,
      { method: "POST", headers: { cookie: owner.cookie, origin: appOrigin } },
      bindings,
    );
    expect(woken.status).toBe(200);
    expect(await woken.json()).toMatchObject({
      data: {
        workspace: "running",
        portals: [{ port: 5173 }],
      },
    });
    expect(execution.calls[0]?.headers.get("x-dx-proxy-wake")).toBe("1");
    const listed = await app.request(
      `${appOrigin}/v1/threads/${threadId}/portals`,
      { headers: { cookie: owner.cookie } },
      bindings,
    );
    expect(listed.status).toBe(200);
    expect(execution.calls[1]?.headers.get("x-dx-proxy-wake")).toBe("0");
  });
});
