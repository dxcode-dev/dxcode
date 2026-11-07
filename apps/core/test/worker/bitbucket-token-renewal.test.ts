import {
  createExecutionContext,
  createScheduledController,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { Effect } from "effect";
import { Hono } from "hono";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppEnv, Bindings } from "../../src/http/types.js";
import { THREAD_SWEEP_CRON } from "../../src/notifications/snooze-cron.js";
import { network } from "./network-boundary.js";

// Bitbucket Cloud as it behaves since CHANGE-3052
// (https://developer.atlassian.com/cloud/bitbucket/changelog/#CHANGE-3052):
// an access token lasts two hours, every refresh rotates the refresh token,
// and a used refresh token is refused with Atlassian's
// `403 {"error":"invalid_grant"}`. These cases drive dx through its HTTP
// routes and its cron, with the real token Durable Object, and fail on the
// code before #1952.

vi.mock("../../src/auth/browser-session.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../src/auth/browser-session.js")
  >()),
  requireBrowserSession: () => Effect.succeed({ sessionId: "browser" }),
}));
vi.mock("../../src/auth/requirements.js", () => ({
  loadAuthenticationRequirements: () => Effect.succeed({}),
}));
vi.mock("../../src/auth/request-auth.js", () => ({ requestAuth: () => ({}) }));

const { bitbucketControlPlaneRoutes } = await import(
  "../../src/source-control/bitbucket/routes.js"
);
const { default: worker } = await import("../../src/cloudflare.js");

const origin = "https://dx.test";
const account = "{33333333-3333-4333-8333-333333333333}";
const ACCESS_LIFETIME_S = 7_200;
const bindings = {
  ...env,
  DB: env.DB,
  DX_AUTH_URL: origin,
  DX_RUNTIME_MODE: "deployed",
  DX_INTEGRATION_BITBUCKET_OAUTH: JSON.stringify({
    version: 1,
    clientId: "client",
    clientSecret: "secret",
    callbackUrl: `${origin}/v1/integrations/bitbucket/oauth/callback`,
  }),
} as Bindings;

/**
 * Marks work started by a request whose Worker invocation Cloudflare
 * cancelled (the client disconnected). Nothing that request started hears
 * back, as in production; work another invocation owns, such as a Durable
 * Object's, is unaffected.
 */
const cancelledRequest = new AsyncLocalStorage<true>();

type Event =
  | { readonly kind: "refresh"; readonly issued: string; readonly at: number }
  | { readonly kind: "refused"; readonly at: number }
  | {
      readonly kind: "user";
      readonly token: string;
      readonly ok: boolean;
      readonly at: number;
    };

/** A Bitbucket that rotates refresh tokens and refuses used ones. */
const fakeBitbucket = () => {
  const state = {
    generation: 0,
    refreshToken: "",
    accessToken: "",
    accessExpiresAt: 0,
    events: [] as Event[],
    /** Makes the next rotation's answer wait until released. */
    hold: undefined as Promise<void> | undefined,
    /** Answers every token call with this status instead. */
    outage: undefined as number | undefined,
  };
  const count = (kind: Event["kind"]) =>
    state.events.filter((event) => event.kind === kind).length;
  const issue = () => {
    state.generation += 1;
    state.accessToken = `access-${state.generation}`;
    state.refreshToken = `refresh-${state.generation}`;
    state.accessExpiresAt = Date.now() + ACCESS_LIFETIME_S * 1_000;
    return HttpResponse.json({
      access_token: state.accessToken,
      refresh_token: state.refreshToken,
      expires_in: ACCESS_LIFETIME_S,
      token_type: "bearer",
      scope: "account repository:write pullrequest:write",
    });
  };
  network.use(
    http.post(
      "https://bitbucket.org/site/oauth2/access_token",
      async ({ request }) => {
        const form = new URLSearchParams(await request.text());
        if (state.outage !== undefined)
          return new HttpResponse("unavailable", { status: state.outage });
        if (form.get("grant_type") === "authorization_code") return issue();
        if (form.get("refresh_token") !== state.refreshToken) {
          state.events.push({ kind: "refused", at: Date.now() });
          return HttpResponse.json(
            {
              error: "invalid_grant",
              error_description: "Unknown or invalid refresh token.",
            },
            { status: 403 },
          );
        }
        // Bitbucket rotates before its answer reaches anyone.
        const answer = issue();
        state.events.push({
          kind: "refresh",
          issued: state.accessToken,
          at: Date.now(),
        });
        if (cancelledRequest.getStore()) return new Promise<never>(() => {});
        if (state.hold !== undefined) await state.hold;
        return answer;
      },
    ),
    http.get("https://api.bitbucket.org/2.0/user/workspaces", () =>
      HttpResponse.json({ values: [] }),
    ),
    http.get("https://api.bitbucket.org/2.0/user", ({ request }) => {
      const token =
        request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
      const ok =
        token === state.accessToken && Date.now() < state.accessExpiresAt;
      state.events.push({ kind: "user", token, ok, at: Date.now() });
      return ok
        ? HttpResponse.json({ uuid: account, nickname: "person" })
        : new HttpResponse("expired", { status: 401 });
    }),
  );
  return {
    state,
    rotations: () => count("refresh"),
    refused: () => count("refused"),
  };
};

let userId = "";
const app = () => {
  const routes = new Hono<AppEnv>();
  routes.use("*", async (context, next) => {
    context.set("requestId", "bitbucket-renewal");
    context.set("principal", {
      userId,
      credentialScopes: ["personal"],
    } as never);
    await next();
  });
  routes.route("/", bitbucketControlPlaneRoutes);
  return routes;
};
const call = (path: string, method = "GET") =>
  app().request(path, { method, headers: { origin } }, bindings);
const connection = async () =>
  (
    (await (await call("/personal/connection")).json()) as {
      data: {
        connection: {
          id: string;
          status: string;
          renewalFailingSince?: string;
        } | null;
      };
    }
  ).data.connection;
const row = () =>
  env.DB.prepare(
    "SELECT * FROM bitbucket_connection WHERE user_id = ? AND status != 'disconnected'",
  )
    .bind(userId)
    .first<Record<string, string | number | null>>();
const tick = async (scheduledTime = Date.now()) => {
  const context = createExecutionContext();
  await worker.scheduled(
    createScheduledController({ cron: THREAD_SWEEP_CRON, scheduledTime }),
    bindings,
    context,
  );
  await waitOnExecutionContext(context);
};
const expireAccessToken = () =>
  env.DB.prepare(
    "UPDATE bitbucket_connection SET expires_at = ? WHERE user_id = ?",
  )
    .bind(new Date(Date.now() - 1_000).toISOString(), userId)
    .run();
const until = async (condition: () => boolean) => {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 10));
  expect(condition()).toBe(true);
};

/** Connects through the real authorize and callback routes. */
const connect = async () => {
  const begin = (await (await call("/personal/authorize", "POST")).json()) as {
    data: { authorizationUrl: string };
  };
  const state = new URL(begin.data.authorizationUrl).searchParams.get("state");
  const callback = await call(`/oauth/callback?state=${state}&code=granted`);
  expect(callback.status).toBe(303);
  expect(await connection()).toMatchObject({ status: "active" });
};

beforeEach(async () => {
  userId = `bitbucket-renewal-${crypto.randomUUID()}`;
  await env.DB.prepare(
    'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1, 1)',
  )
    .bind(userId, "Renewal", `${userId}@example.com`)
    .run();
});
afterEach(async () => {
  vi.useRealTimers();
  // The shared reset deletes users; their Bitbucket rows go first.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM bitbucket_git_lease"),
    env.DB.prepare("DELETE FROM bitbucket_repository"),
    env.DB.prepare("DELETE FROM bitbucket_oauth_state"),
    env.DB.prepare("DELETE FROM bitbucket_connection"),
  ]);
});

it("keeps the rotation when the request that started the refresh is cancelled after Bitbucket rotated (production, 7 Nov 09:35)", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const bitbucket = fakeBitbucket();
  await connect();
  await expireAccessToken();

  // The repository list starts a refresh; Bitbucket rotates; the browser
  // leaves and Cloudflare cancels that request before the answer arrives.
  void cancelledRequest.run(true, () =>
    call("/personal/repositories").catch(() => undefined),
  );
  await until(() => bitbucket.rotations() === 1);
  // Hours later, with no lock left fresh, the person opens Settings.
  vi.setSystemTime(Date.now() + 60_000);

  const refresh = await call("/personal/refresh", "POST");
  expect(refresh.status).toBe(200);
  expect(await connection()).toMatchObject({ status: "active" });
  expect(bitbucket.refused()).toBe(0);
  // The rotated token is the one dx kept and used.
  expect(bitbucket.state.events.at(-1)).toMatchObject({
    kind: "user",
    token: bitbucket.state.accessToken,
    ok: true,
  });
});

it("never replays a refresh token while another refresh of it is still waiting for Bitbucket (lock takeover)", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const bitbucket = fakeBitbucket();
  await connect();
  await expireAccessToken();
  let release!: () => void;
  bitbucket.state.hold = new Promise((resolve) => {
    release = resolve;
  });
  // The first refresh reaches Bitbucket, which rotates and answers slowly.
  const first = call("/personal/refresh", "POST");
  await until(() => bitbucket.rotations() === 1);
  // Longer than any refresh lock: a second request arrives meanwhile.
  vi.setSystemTime(Date.now() + 60_000);
  const second = call("/personal/refresh", "POST");
  await new Promise((resolve) => setTimeout(resolve, 100));
  release();

  expect((await first).status).toBe(200);
  expect((await second).status).toBe(200);
  expect(bitbucket.refused()).toBe(0);
  expect(await connection()).toMatchObject({ status: "active" });
  // And the connection keeps working afterwards.
  await expireAccessToken();
  expect((await call("/personal/refresh", "POST")).status).toBe(200);
  expect(bitbucket.refused()).toBe(0);
});

it("rotates once for three simultaneous requests, and every caller gets the new token", async () => {
  const bitbucket = fakeBitbucket();
  await connect();
  await expireAccessToken();
  let release!: () => void;
  bitbucket.state.hold = new Promise((resolve) => {
    release = resolve;
  });
  const requests = [1, 2, 3].map(() => call("/personal/refresh", "POST"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  release();
  const responses = await Promise.all(requests);
  expect(responses.map(({ status }) => status)).toEqual([200, 200, 200]);
  expect(bitbucket.rotations()).toBe(1);
  expect(bitbucket.refused()).toBe(0);
  expect(await connection()).toMatchObject({ status: "active" });
});

it("keeps an untouched connection alive for 48 hours on the cron alone, checking every new token with Bitbucket", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const bitbucket = fakeBitbucket();
  await connect();
  const start = Date.now();
  const expiries: number[] = [];
  // Nobody uses dx. The Worker cron fires every minute; sample every 5.
  for (let at = start; at <= start + 48 * 3_600_000; at += 5 * 60_000) {
    vi.setSystemTime(at);
    await tick(at);
    const current = await row();
    const expiresAt = Date.parse(String(current?.expires_at));
    // The stored access token never lapses.
    expect(current?.status).toBe("active");
    expect(expiresAt).toBeGreaterThan(at);
    if (expiries.at(-1) !== expiresAt) expiries.push(expiresAt);
  }

  // A 2-hour token renewed 30 minutes early: one rotation per 90 minutes.
  expect(bitbucket.rotations()).toBeGreaterThanOrEqual(30);
  expect(bitbucket.rotations()).toBeLessThanOrEqual(34);
  expect(bitbucket.refused()).toBe(0);
  // Every rotation was followed by an authenticated call that Bitbucket
  // accepted with exactly the token it had just issued.
  const events = bitbucket.state.events;
  events.forEach((event, index) => {
    if (event.kind !== "refresh") return;
    expect(events[index + 1]).toMatchObject({
      kind: "user",
      token: event.issued,
      ok: true,
    });
  });
  // expires_at only ever moved forward.
  expect(expiries).toEqual([...expiries].sort((a, b) => a - b));
  expect(expiries.length).toBe(bitbucket.rotations() + 1);
  expect(await connection()).toMatchObject({ status: "active" });
  expect((await row())?.last_verified_at).toEqual(expect.any(String));
}, 180_000);

it("says Reconnect, once, when Bitbucket refuses a refresh token whose rotation was lost", async () => {
  const bitbucket = fakeBitbucket();
  await connect();
  // A refresh reached Bitbucket, which rotated, and its answer never came
  // back. dx still holds the used refresh token and an abandoned lock.
  bitbucket.state.refreshToken = "rotated-away";
  await env.DB.prepare(
    "UPDATE bitbucket_connection SET expires_at = ?, refresh_lock_id = 'abandoned', refresh_lock_until = ? WHERE user_id = ?",
  )
    .bind("2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z", userId)
    .run();

  const refresh = await call("/personal/refresh", "POST");
  expect(refresh.status).toBe(200);
  expect(await connection()).toMatchObject({
    status: "reauthorization-required",
  });
  // The repository list and the cron do not keep hammering Bitbucket.
  await call("/personal/repositories");
  await tick();
  await tick();
  expect(bitbucket.refused()).toBe(1);
});

it("keeps the connection through a Bitbucket outage and reports that renewal is failing", async () => {
  const bitbucket = fakeBitbucket();
  await connect();
  await env.DB.prepare(
    "UPDATE bitbucket_connection SET expires_at = ? WHERE user_id = ?",
  )
    .bind(new Date(Date.now() + 10 * 60_000).toISOString(), userId)
    .run();
  bitbucket.state.outage = 503;
  await tick();
  expect(await connection()).toMatchObject({
    status: "active",
    renewalFailingSince: expect.any(String),
  });

  // Bitbucket recovers; the retry a few minutes later succeeds and clears
  // the warning.
  bitbucket.state.outage = undefined;
  await tick(Date.now() + 5 * 60_000);
  const after = await connection();
  expect(after).toMatchObject({ status: "active" });
  expect(after?.renewalFailingSince).toBeUndefined();
  expect(bitbucket.refused()).toBe(0);
});
