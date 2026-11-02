import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import app from "../../src/app.js";
import type { Bindings } from "../../src/http/types.js";
import { muteSpanLogRecords } from "../../src/observability/tracing.js";
import { TEST_CONFIG_ENCRYPTION_KEYS } from "../../src/testing/bindings.js";
import {
  countD1Calls,
  type D1Call,
  summarizeD1Calls,
} from "./d1-call-counter.js";

/**
 * D1 round trips per personal settings write (#1130), through the Worker app
 * with a real Better Auth browser session. Staging's D1 is a continent away
 * from most browsers, so every sequential round trip costs 150–250 ms there:
 * a write must take a few, and the number must not grow with how many
 * skills the person has. Each write runs for an account with one skill and
 * one with eight. DX_RECORD_D1_CALLS=<name> writes the counts to
 * artifacts/settings-write-d1-calls/<name>.json:
 *
 *   DX_RECORD_D1_CALLS=after pnpm exec vitest run \
 *     --config vitest.worker.config.ts test/worker/settings-write-d1-calls.test.ts -u
 */

declare const __DX_RECORD_D1_CALLS__: string;

muteSpanLogRecords();

const origin = "http://dx.test";
const counter = countD1Calls(env.DB);
const bindings: Bindings = {
  DB: counter.db,
  DX_ENV: "local",
  DX_RUNTIME_MODE: "local",
  DX_AUTH_URL: origin,
  DX_AUTH_TRUSTED_ORIGINS: origin,
  DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
  BETTER_AUTH_SECRET: "settings-write-d1-calls-secret-0000000",
};

/** Most sequential D1 round trips a write may wait for, session included. */
const BUDGET = 4;
const SKILL_COUNTS = [1, 8] as const;

const file = (path: string, mediaType: string, content: string) => ({
  path,
  kind: "file",
  mediaType,
  encoding: "utf-8",
  content,
});

const bundle = (name: string, revision: number) => ({
  source: { type: "browser-files", label: "Created in settings" },
  files: [
    file(
      "skill.json",
      "application/json",
      JSON.stringify({
        schemaVersion: 1,
        name,
        description: `Revision ${revision} of ${name}.`,
        mcpServerIds: [],
      }),
    ),
    file("instructions.md", "text/markdown", `Follow ${name} r${revision}.`),
    file("resources/notes.md", "text/markdown", `Notes r${revision}.`),
  ],
});

let signups = 0;
const signup = async () => {
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
        name: "Settings Writer",
        email: `settings-writes-${crypto.randomUUID()}@example.com`,
        password: "settings-writes-password-123",
      }),
    },
    bindings,
  );
  expect(response.status).toBe(200);
  // The session token and Better Auth's signed cache cookie, as the web app
  // sends them.
  return response.headers
    .getSetCookie()
    .map((line) => line.split(";", 1)[0] ?? "")
    .join("; ");
};

const send = async (
  cookie: string,
  method: string,
  path: string,
  body?: unknown,
) => {
  const pending: Array<Promise<unknown>> = [];
  counter.reset();
  const response = await app.request(
    path,
    {
      method,
      headers: {
        cookie,
        origin,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
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
  const calls: ReadonlyArray<D1Call> = [...counter.calls];
  const json = (await response.json()) as { data: Record<string, unknown> };
  await Promise.allSettled(pending);
  return { status: response.status, data: json.data, calls };
};

const skillsPath = "/v1/settings/personal/skills";
const variablesPath = "/v1/settings/personal/environment-variables";

const createSkill = async (cookie: string, name: string) => {
  const preview = await send(cookie, "POST", `${skillsPath}/preview`, {
    ...bundle(name, 1),
  });
  expect(preview.status).toBe(200);
  const created = await send(cookie, "POST", skillsPath, {
    bundle: bundle(name, 1),
    reviewedIntegrity: preview.data.integrity,
    enabled: true,
  });
  expect(created.status).toBe(201);
  return created.data.id as string;
};

const results: Record<string, unknown> = {};
const sequentialBy: Record<string, Record<number, number>> = {};

const record = (
  write: string,
  skills: number,
  outcome: Awaited<ReturnType<typeof send>>,
  status: number,
) => {
  expect(outcome.status).toBe(status);
  const summary = summarizeD1Calls(outcome.calls);
  results[`${write} (${skills} skills)`] = { status, ...summary };
  sequentialBy[write] = {
    ...sequentialBy[write],
    [skills]: summary.sequential,
  };
  return summary;
};

const writes = async (count: number) => {
  const cookie = await signup();
  let skillId = "";
  for (let index = 0; index < count; index++)
    skillId = await createSkill(cookie, `writes-skill-${index}`);

  const off = await send(cookie, "PATCH", `${skillsPath}/${skillId}`, {
    enabled: false,
  });
  expect(off.data).toMatchObject({
    enabled: false,
    effectiveState: "disabled",
  });
  record("PATCH skill off", count, off, 200);
  const on = await send(cookie, "PATCH", `${skillsPath}/${skillId}`, {
    enabled: true,
  });
  expect(on.data).toMatchObject({ enabled: true, effectiveState: "effective" });
  record("PATCH skill on", count, on, 200);

  const next = bundle(`writes-skill-${count - 1}`, 2);
  const preview = await send(cookie, "POST", `${skillsPath}/preview`, next);
  record("POST skill preview", count, preview, 200);
  const published = await send(
    cookie,
    "POST",
    `${skillsPath}/${skillId}/versions`,
    { bundle: next, reviewedIntegrity: preview.data.integrity, activate: true },
  );
  expect(published.data).toMatchObject({ activeVersion: 2, versions: [2, 1] });
  expect(
    (published.data.active as { resources: ReadonlyArray<unknown> }).resources,
  ).toHaveLength(1);
  record("POST skill version", count, published, 201);

  const created = await send(cookie, "POST", variablesPath, {
    scope: "personal",
    name: "WRITES_CHANNEL",
    kind: "variable",
    value: "beta",
  });
  record("POST environment variable", count, created, 201);
  const id = (created.data.reference as { id: string }).id;
  const deleted = await send(cookie, "DELETE", `${variablesPath}/${id}`);
  record("DELETE environment variable", count, deleted, 200);

  const listed = await send(cookie, "GET", skillsPath);
  expect(listed.data.items).toHaveLength(count);
  record("GET skills", count, listed, 200);
};

describe("personal settings writes", () => {
  it.each(SKILL_COUNTS)(
    "take a few round trips with %i skills",
    async (count) => {
      await writes(count);
      const overBudget = Object.entries(results).filter(
        ([name, summary]) =>
          name.endsWith(`(${count} skills)`) &&
          !name.startsWith("GET") &&
          (summary as { sequential: number }).sequential > BUDGET,
      );
      expect(overBudget).toEqual([]);
    },
  );
});

describe("round trips by skill count", () => {
  it("do not grow with the number of skills", () => {
    for (const [write, counts] of Object.entries(sequentialBy))
      expect({ write, sequential: counts[8] }).toEqual({
        write,
        sequential: counts[1],
      });
  });

  it("records the counts when asked", async () => {
    if (__DX_RECORD_D1_CALLS__ === "") return;
    await expect(
      `${JSON.stringify(
        {
          source:
            "apps/core/test/worker/settings-write-d1-calls.test.ts (local workerd, real D1)",
          notes: [
            "Counted up to the response, with the session token and Better Auth's cache cookie.",
            "roundTrips: D1 calls (a batch is one); statements: each batched statement; sequential: longest chain of non-overlapping calls.",
          ],
          requests: results,
        },
        null,
        2,
      )}\n`,
    ).toMatchFileSnapshot(
      `../../../../artifacts/settings-write-d1-calls/${__DX_RECORD_D1_CALLS__}.json`,
    );
  });
});
