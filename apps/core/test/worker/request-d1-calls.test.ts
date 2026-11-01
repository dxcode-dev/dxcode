import { env } from "cloudflare:test";
import { ProjectRepository, ThreadRepository, type UserId } from "@dx/domain";
import { Effect } from "effect";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { useAgentAdmission } from "../../src/agents/admission.js";
import app from "../../src/app.js";
import { authenticate } from "../../src/auth/authenticate.js";
import { authorizeApiTokenScope } from "../../src/auth/authorize-api-token-scope.js";
import { errorHandler } from "../../src/http/http-errors.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv, Bindings } from "../../src/http/types.js";
import {
  countD1Calls,
  type D1Call,
  summarizeD1Calls,
} from "./d1-call-counter.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

/**
 * D1 round trips per request on the hot authenticated routes, through the
 * Worker app with a real Better Auth browser session (#1343). Each route runs
 * twice per cookie jar and the second request is counted, once the isolate's
 * session revocation view is warm:
 *
 * - cached: the session token and Better Auth's signed cache cookie, as the
 *   web app sends them;
 * - token only: the session token alone, so every session lookup reads D1.
 *
 * A request may read the session from D1 at most once and never introspects
 * the schema. DX_RECORD_D1_CALLS=<name> writes the counts to
 * artifacts/request-d1-calls/<name>.json:
 *
 *   DX_RECORD_D1_CALLS=after pnpm exec vitest run \
 *     --config vitest.worker.config.ts test/worker/request-d1-calls.test.ts -u
 */

declare const __DX_RECORD_D1_CALLS__: string;

const origin = "http://dx.test";
const counter = countD1Calls(env.DB);
const bindings: Bindings = {
  DB: counter.db,
  DX_ENV: "local",
  DX_RUNTIME_MODE: "local",
  DX_AUTH_URL: origin,
  DX_AUTH_TRUSTED_ORIGINS: origin,
  BETTER_AUTH_SECRET: "request-d1-calls-secret-0000000000000",
  DX_INSTALLED_PLUGINS: "speech",
  DX_STORAGE: env.DX_STORAGE,
  REALTIME_HUB: env.REALTIME_HUB,
};

const projectId = "prj_00000000-0000-4000-8000-000000001343";
const threadId = "thr_00000000-0000-4000-8000-000000001343";
const jars = { cached: "", "token only": "" };
let signups = 0;

/**
 * What a call is for. Better Auth's Kysely adapter writes lowercase SQL with
 * quoted identifiers, unlike dx's own queries.
 */
const purpose = (sql: string) => {
  if (/sqlite_master|pragma_table_info|index_list|index_info/i.test(sql))
    return "schema introspection";
  if (/session_revocation/.test(sql)) return "session revocation";
  const betterAuth = /^(?:select|insert|update|delete)\b/.test(sql)
    ? /\b(?:from|into|update)\s+"(\w+)"/.exec(sql)?.[1]
    : undefined;
  if (betterAuth !== undefined) return `better auth ${betterAuth}`;
  return "route";
};

const purposes = (calls: ReadonlyArray<D1Call>) => {
  const counts: Record<string, number> = {};
  for (const call of calls)
    for (const sql of call.sql) {
      const key = purpose(sql);
      counts[key] = (counts[key] ?? 0) + 1;
    }
  return Object.fromEntries(Object.entries(counts).sort());
};

beforeEach(async () => {
  const email = `round-trips-${crypto.randomUUID()}@example.com`;
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
        name: "Round Trip Owner",
        email,
        password: "round-trip-password-123",
      }),
    },
    bindings,
  );
  expect(response.status).toBe(200);
  const cookies = response.headers
    .getSetCookie()
    .map((line) => line.split(";", 1)[0] ?? "");
  jars.cached = cookies.join("; ");
  jars["token only"] = cookies
    .filter((cookie) => cookie.includes("session_token"))
    .join("; ");
  expect(jars.cached).toContain("session_data");
  expect(jars["token only"]).not.toContain("session_data");
  const user = await env.DB.prepare('SELECT id FROM "user" WHERE email=?')
    .bind(email)
    .first<{ id: UserId }>();
  if (!user) throw new Error("Expected user");
  await runRepositories(
    Effect.gen(function* () {
      yield* (yield* ProjectRepository).insert(
        project(projectId, user.id, "Round trips"),
      );
      yield* (yield* ThreadRepository).insert(
        thread(threadId, projectId as never, user.id),
      );
    }),
  );
  await env.DB.prepare(
    "UPDATE projects SET runner_profile_id = 'a1.medium'",
  ).run();
});

/** One second of loud 16 kHz mono 16-bit PCM in a WAV container. */
const wav = () => {
  const samples = 16_000;
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++)
      bytes[offset + index] = value.charCodeAt(index);
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples * 2, true);
  for (let at = 44; at < bytes.byteLength; at += 2)
    view.setInt16(at, 900, true);
  return bytes;
};

/**
 * Message send as app.ts mounts it, with Flue's native route replaced: Flue
 * keeps the message in its Durable Object, not D1, and needs a Flue-built
 * server entry the test Worker lacks.
 */
const messageApp = new Hono<AppEnv>();
messageApp.use("*", requestId);
messageApp.use("/v1/*", authenticate);
messageApp.use("/v1/*", authorizeApiTokenScope);
messageApp.route(
  "/v1/agents/dx",
  useAgentAdmission(new Hono<AppEnv>()).post("/:threadId", (context) =>
    context.json({ submissionId: "accepted" }, 202),
  ),
);
messageApp.onError(errorHandler);

const routes: ReadonlyArray<{
  readonly app?: Hono<AppEnv>;
  readonly name: string;
  readonly status: number;
  readonly path: () => string;
  readonly init: () => RequestInit;
}> = [
  {
    name: "GET /v1/projects",
    status: 200,
    path: () => "/v1/projects",
    init: () => ({}),
  },
  {
    name: "GET /v1/threads",
    status: 200,
    path: () => "/v1/threads",
    init: () => ({}),
  },
  {
    name: "GET /v1/threads/:threadId",
    status: 200,
    path: () => `/v1/threads/${threadId}`,
    init: () => ({}),
  },
  {
    name: "POST /v1/dictation/:id",
    status: 200,
    path: () => `/v1/dictation/${crypto.randomUUID()}`,
    init: () => ({
      method: "POST",
      headers: { "content-type": "audio/wav" },
      body: wav(),
    }),
  },
  {
    app: messageApp,
    name: "POST /v1/agents/dx/:threadId",
    status: 202,
    path: () => `/v1/agents/dx/${threadId}`,
    init: () => ({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "user",
        body: "Run the tests",
        idempotencyKey: crypto.randomUUID(),
      }),
    }),
  },
];

const send = async (route: (typeof routes)[number], cookie: string) => {
  const init = route.init();
  const headers = new Headers(init.headers);
  headers.set("cookie", cookie);
  headers.set("origin", origin);
  const pending: Array<Promise<unknown>> = [];
  counter.reset();
  const response = await (route.app ?? app).request(
    route.path(),
    { ...init, headers },
    bindings,
    {
      waitUntil: (promise: Promise<unknown>) => {
        pending.push(promise);
      },
      passThroughOnException: () => {},
      props: {},
    } as unknown as ExecutionContext,
  );
  // Counted to the response; waitUntil work does not delay it.
  const calls = [...counter.calls];
  await response.arrayBuffer();
  await Promise.allSettled(pending);
  return { status: response.status, calls };
};

const results: Record<string, unknown> = {};

describe("D1 round trips per authenticated request", () => {
  describe.each(Object.keys(jars) as Array<keyof typeof jars>)("%s", (jar) => {
    it.each(routes)("$name", async (route) => {
      await send(route, jars[jar]);
      const { status, calls } = await send(route, jars[jar]);
      const counts = purposes(calls);
      results[`${route.name} (${jar})`] = {
        status,
        ...summarizeD1Calls(calls),
        purposes: counts,
      };
      expect(status).toBe(route.status);
      expect(counts["schema introspection"]).toBeUndefined();
      expect(counts["better auth session"] ?? 0).toBeLessThanOrEqual(1);
      expect(counts["better auth user"] ?? 0).toBeLessThanOrEqual(1);
    });
  });

  it("records the counts when asked", async () => {
    if (__DX_RECORD_D1_CALLS__ === "") return;
    await expect(
      `${JSON.stringify(
        {
          source:
            "apps/core/test/worker/request-d1-calls.test.ts (local workerd, real D1)",
          notes: [
            "Counted up to the response, on the second request per route and cookie jar.",
            "roundTrips: D1 calls (a batch is one); statements: each batched statement; sequential: longest chain of non-overlapping calls.",
            "purposes: statements by what they are for; route is the route's own work.",
          ],
          requests: results,
        },
        null,
        2,
      )}\n`,
    ).toMatchFileSnapshot(
      `../../../../artifacts/request-d1-calls/${__DX_RECORD_D1_CALLS__}.json`,
    );
  });
});

describe("Sharing the request's session lookup", () => {
  const sessionToken = (jar: string) =>
    decodeURIComponent(
      /session_token=([^;.]+)/.exec(jar)?.[1] ?? "missing-session-token",
    );

  /** Ends the session in D1 as another isolate would, unseen by this one. */
  const endSessionElsewhere = async (jar: string) => {
    const token = sessionToken(jar);
    const sessions = () =>
      env.DB.prepare('SELECT count(*) AS count FROM "session" WHERE token=?')
        .bind(token)
        .first("count");
    expect(await sessions()).toBe(1);
    await env.DB.prepare('DELETE FROM "session" WHERE token=?')
      .bind(token)
      .run();
    expect(await sessions()).toBe(0);
  };

  const dictation = routes.find(
    (route) => route.name === "POST /v1/dictation/:id",
  );
  if (dictation === undefined) throw new Error("Expected dictation route.");
  const security = {
    name: "GET /v1/settings/personal/security/sessions",
    status: 200,
    path: () => "/v1/settings/personal/security/sessions",
    init: () => ({}),
  };

  it.each([dictation, security])(
    "refuses a revoked session at once on $name, though the cookie cache still admits it",
    async (route) => {
      const before = await send(route, jars.cached);
      expect(before.status).toBe(route.status);
      await endSessionElsewhere(jars.cached);
      // Within the revocation window this isolate still trusts the cache...
      expect((await send(routes[0] ?? route, jars.cached)).status).toBe(200);
      // ...but a browser-session check reads D1 and refuses it.
      const after = await send(route, jars.cached);
      expect(after.status).toBe(403);
      expect(
        after.calls.filter((call) =>
          call.sql.some((sql) => purpose(sql) === "better auth session"),
        ),
      ).toHaveLength(1);
    },
  );

  it.each([dictation, security])(
    "refuses a revoked token-only session at once on $name",
    async (route) => {
      expect((await send(route, jars["token only"])).status).toBe(route.status);
      await endSessionElsewhere(jars["token only"]);
      const after = await send(route, jars["token only"]);
      expect(after.status).toBe(401);
    },
  );
});
