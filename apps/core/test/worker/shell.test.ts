import { env } from "cloudflare:test";
import { SHELL_PARTS, type ShellPartName } from "@dx/api";
import { ProjectRepository, ThreadRepository, type UserId } from "@dx/domain";
import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import app from "../../src/app.js";
import type { Bindings } from "../../src/http/types.js";
import {
  TEST_CONFIG_ENCRYPTION_KEYS,
  TEST_RUNNER_PROFILE_CATALOG,
} from "../../src/testing/bindings.js";
import { countD1Calls, summarizeD1Calls } from "./d1-call-counter.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

/**
 * `GET /v1/shell` (#1379): the signed-in shell's first-load reads in one
 * request. Each part must be exactly what its own route answers, read with
 * the shell request's one session lookup, and the parts run at once.
 *
 * DX_RECORD_D1_CALLS=<name> also writes the shell's and each part's D1 round
 * trips to artifacts/shell-d1-calls/<name>.json.
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
  BETTER_AUTH_SECRET: "shell-route-secret-000000000000000000",
  DX_RUNNER_PROFILE_CATALOG: TEST_RUNNER_PROFILE_CATALOG,
  DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
  BYOK_CREDENTIAL_COORDINATOR: env.BYOK_CREDENTIAL_COORDINATOR,
  DX_STORAGE: env.DX_STORAGE,
  REALTIME_HUB: env.REALTIME_HUB,
};

const projectId = "prj_00000000-0000-4000-8000-000000001379";
const threadId = "thr_00000000-0000-4000-8000-000000001379";
const jars = { cached: "", "token only": "" };
let signups = 0;

beforeEach(async () => {
  const email = `shell-${crypto.randomUUID()}@example.com`;
  const response = await app.request(
    "/api/auth/sign-up/email",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        "cf-connecting-ip": `198.51.100.${++signups}`,
      },
      body: JSON.stringify({
        name: "Shell Owner",
        email,
        password: "shell-route-password-123",
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
  await runRepositories(
    Effect.gen(function* () {
      yield* (yield* ProjectRepository).insert(
        project(projectId, user.id, "Shell"),
      );
      yield* (yield* ThreadRepository).insert(
        thread(threadId, projectId as never, user.id),
      );
    }),
  );
});

const get = async (
  path: string,
  headers: Record<string, string>,
  env: Bindings = bindings,
) => {
  const pending: Array<Promise<unknown>> = [];
  counter.reset();
  const response = await app.request(
    path,
    { headers: { origin, ...headers } },
    env,
    {
      waitUntil: (promise: Promise<unknown>) => {
        pending.push(promise);
      },
      passThroughOnException: () => {},
      props: {},
    } as unknown as ExecutionContext,
  );
  const calls = [...counter.calls];
  const body: unknown = await response.json();
  await Promise.allSettled(pending);
  return { status: response.status, body, calls };
};

/** A body without its request IDs, which differ per request. */
const withoutRequestIds = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(withoutRequestIds)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([key]) => key !== "requestId")
            .map(([key, item]) => [key, withoutRequestIds(item)]),
        )
      : value;

const sessionReads = (calls: ReturnType<typeof countD1Calls>["calls"]) =>
  calls.filter((call) => call.sql.some((sql) => /\bfrom\s+"session"/.test(sql)))
    .length;

const names = Object.keys(SHELL_PARTS) as ShellPartName[];
const results: Record<string, unknown> = {};

describe("GET /v1/shell", () => {
  it.each(Object.keys(jars) as Array<keyof typeof jars>)(
    "answers every part as its own route does (%s)",
    async (jar) => {
      const cookie = jars[jar];
      // Warm the isolate's session view, as request-d1-calls does.
      await get("/v1/shell", { cookie });
      const shell = await get("/v1/shell", { cookie });
      expect(shell.status).toBe(200);
      const data = (
        shell.body as {
          status: string;
          data: Record<ShellPartName, { status: number; body: unknown }>;
        }
      ).data;
      expect(Object.keys(data).sort()).toEqual([...names].sort());
      const direct: Record<string, unknown> = {};
      for (const name of names) {
        const alone = await get(SHELL_PARTS[name], { cookie });
        expect({ name, status: data[name].status }).toEqual({
          name,
          status: alone.status,
        });
        expect({ name, status: alone.status }).toEqual({ name, status: 200 });
        expect(withoutRequestIds(data[name].body)).toEqual(
          withoutRequestIds(alone.body),
        );
        direct[name] = summarizeD1Calls(alone.calls);
      }
      // One session lookup serves every part.
      expect(sessionReads(shell.calls)).toBeLessThanOrEqual(1);
      const summary = summarizeD1Calls(shell.calls);
      const sequential = (value: unknown) =>
        (value as { sequential: number }).sequential;
      const deepest = Math.max(...Object.values(direct).map(sequential));
      const serial = Object.values(direct)
        .map(sequential)
        .reduce((sum, value) => sum + value, 0);
      // The parts overlap: the shell waits about as long as its slowest part.
      expect(sequential(summary)).toBeLessThan(serial);
      results[jar] = { shell: summary, deepestPart: deepest, serial, direct };
    },
  );

  it("answers a failing part with its own error and the rest as usual", async () => {
    // Without the runner catalog, Project defaults cannot answer.
    const { DX_RUNNER_PROFILE_CATALOG: _catalog, ...broken } = bindings;
    const cookie = jars.cached;
    const shell = await get("/v1/shell", { cookie }, broken);
    expect(shell.status).toBe(200);
    const data = (
      shell.body as {
        data: Record<ShellPartName, { status: number; body: unknown }>;
      }
    ).data;
    const alone = await get(SHELL_PARTS.personalProjects, { cookie }, broken);
    expect(alone.status).toBeGreaterThanOrEqual(500);
    expect(data.personalProjects.status).toBe(alone.status);
    expect(withoutRequestIds(data.personalProjects.body)).toEqual(
      withoutRequestIds(alone.body),
    );
    expect(data.threads.status).toBe(200);
    expect(data.settings.status).toBe(200);
  });

  it("is for a signed-in browser only", async () => {
    expect((await get("/v1/shell", {})).status).toBe(401);
    expect(
      (await get("/v1/shell", { authorization: "Bearer dxu_not-a-real-key0" }))
        .status,
    ).toBe(401);
  });

  it("records the counts when asked", async () => {
    if (__DX_RECORD_D1_CALLS__ === "") return;
    await expect(
      `${JSON.stringify(
        {
          source:
            "apps/core/test/worker/shell.test.ts (local workerd, real D1)",
          notes: [
            "shell: GET /v1/shell; direct: each part requested alone; serial: the parts' sequential round trips added up, as the web app reads them today in about four rounds.",
            "roundTrips: D1 calls (a batch is one); sequential: longest chain of non-overlapping calls.",
          ],
          results,
        },
        null,
        2,
      )}\n`,
    ).toMatchFileSnapshot(
      `../../../../artifacts/shell-d1-calls/${__DX_RECORD_D1_CALLS__}.json`,
    );
  });
});
