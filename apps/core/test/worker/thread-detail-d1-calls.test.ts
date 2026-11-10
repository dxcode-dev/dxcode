import { env } from "cloudflare:test";
import { ProjectRepository, ThreadRepository, type UserId } from "@dx/domain";
import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import app from "../../src/app.js";
import type { Bindings } from "../../src/http/types.js";
import {
  TEST_CONFIG_ENCRYPTION_KEYS,
  TEST_RUNNER_PROFILE_CATALOG,
} from "../../src/testing/bindings.js";
import {
  countD1Calls,
  type D1Call,
  summarizeD1Calls,
} from "./d1-call-counter.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

/**
 * D1 round trips of `GET /v1/threads/:threadId`, the read a Thread's page
 * waits on before it shows (#1156). The route runs twice per cookie jar and
 * the second request is counted, once the isolate's session view is warm.
 *
 * DX_RECORD_D1_CALLS=<name> writes the counts and each call's SQL to
 * artifacts/thread-detail-d1-calls/<name>.json.
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
  BETTER_AUTH_SECRET: "thread-detail-d1-secret-000000000000",
  DX_RUNNER_PROFILE_CATALOG: TEST_RUNNER_PROFILE_CATALOG,
  DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
  DX_STORAGE: env.DX_STORAGE,
  REALTIME_HUB: env.REALTIME_HUB,
};

const projectId = "prj_00000000-0000-4000-8000-000000001156";
const threadId = "thr_00000000-0000-4000-8000-000000001156";
const jars = { cached: "", "token only": "" };
let signups = 0;
let ownerId: UserId;

beforeEach(async () => {
  const email = `thread-detail-${crypto.randomUUID()}@example.com`;
  const response = await app.request(
    "/api/auth/sign-up/email",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        "cf-connecting-ip": `192.0.2.${++signups}`,
      },
      body: JSON.stringify({
        name: "Thread Detail Owner",
        email,
        password: "thread-detail-password-123",
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
  const user = await env.DB.prepare('SELECT id FROM "user" WHERE email=?')
    .bind(email)
    .first<{ id: UserId }>();
  if (!user) throw new Error("Expected user");
  ownerId = user.id;
  await runRepositories(
    Effect.gen(function* () {
      yield* (yield* ProjectRepository).insert(
        project(projectId, user.id, "Thread detail"),
      );
      yield* (yield* ThreadRepository).insert(
        thread(threadId, projectId as never, user.id),
      );
    }),
  );
});

const get = async (cookie: string, path = `/v1/threads/${threadId}`) => {
  const pending: Array<Promise<unknown>> = [];
  counter.reset();
  const response = await app.request(
    path,
    { headers: { origin, cookie } },
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
  const body = (await response.json()) as { data?: { id?: string } };
  await Promise.allSettled(pending);
  return { status: response.status, body, calls };
};

const describeCalls = (calls: ReadonlyArray<D1Call>) =>
  [...calls]
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((call) => ({
      method: call.method,
      startedAt: Math.round(call.startedAt * 10) / 10,
      endedAt: Math.round(call.endedAt * 10) / 10,
      sql: call.sql.map((sql) => sql.slice(0, 160)),
    }));

const results: Record<string, unknown> = {};

describe("GET /v1/threads/:threadId round trips", () => {
  it.each(Object.keys(jars) as Array<keyof typeof jars>)("%s", async (jar) => {
    await get(jars[jar]);
    const { status, body, calls } = await get(jars[jar]);
    expect(status).toBe(200);
    expect(body.data?.id).toBe(threadId);
    const summary = summarizeD1Calls(calls);
    results[jar] = { ...summary, owner: ownerId, calls: describeCalls(calls) };
    // The page waits on this read, so its D1 rounds are the floor of its
    // first paint. A token-only session adds its own lookup's two.
    expect(summary.sequential).toBeLessThanOrEqual(jar === "cached" ? 4 : 6);
  });

  // The Spaces gate needs each Thread's kind (spaces/gate.ts). It never
  // changes, so an isolate keeps it from any Thread row it reads, such as
  // the sidebar's list, and reads it at most once per Thread otherwise.
  it("reads a Thread's kind for the Spaces gate once per isolate, and not at all after a list", async () => {
    await get(jars.cached);
    const unseen = () =>
      `thr_00000000-0000-4000-8000-${crypto.randomUUID().slice(-12)}`;
    const insert = (id: string) =>
      runRepositories(
        Effect.gen(function* () {
          yield* (yield* ThreadRepository).insert(
            thread(id, projectId as never, ownerId),
          );
        }),
      );
    const kindReads = (calls: ReadonlyArray<D1Call>) =>
      calls.filter((call) =>
        call.sql.some((sql) =>
          // The gate's read also takes the execution mode (orb-free.ts).
          sql.includes("SELECT kind, execution_mode FROM threads"),
        ),
      ).length;

    // Listed first, as the sidebar does: no kind read, rounds unchanged.
    const listed = unseen();
    await insert(listed);
    await get(jars.cached, "/v1/threads?roots=true");
    const afterList = await get(jars.cached, `/v1/threads/${listed}`);
    expect(afterList.status).toBe(200);
    expect(kindReads(afterList.calls)).toBe(0);
    expect(summarizeD1Calls(afterList.calls).sequential).toBeLessThanOrEqual(4);

    // Opened by link in an isolate that never read it: one kind read, one
    // round more, and none the next time.
    const linked = unseen();
    await insert(linked);
    const first = await get(jars.cached, `/v1/threads/${linked}`);
    expect(first.status).toBe(200);
    expect(kindReads(first.calls)).toBe(1);
    expect(summarizeD1Calls(first.calls).sequential).toBeLessThanOrEqual(5);
    const again = await get(jars.cached, `/v1/threads/${linked}`);
    expect(kindReads(again.calls)).toBe(0);
    expect(summarizeD1Calls(again.calls).sequential).toBeLessThanOrEqual(4);
  });

  it("records the counts when asked", async () => {
    if (__DX_RECORD_D1_CALLS__ === "") return;
    await expect(
      `${JSON.stringify(
        {
          source:
            "apps/core/test/worker/thread-detail-d1-calls.test.ts (local workerd, real D1)",
          notes: [
            "Counted up to the response, on the second request per cookie jar.",
            "roundTrips: D1 calls (a batch is one); sequential: longest chain of non-overlapping calls.",
          ],
          results,
        },
        null,
        2,
      )}\n`,
    ).toMatchFileSnapshot(
      `../../../../artifacts/thread-detail-d1-calls/${__DX_RECORD_D1_CALLS__}.json`,
    );
  });
});
