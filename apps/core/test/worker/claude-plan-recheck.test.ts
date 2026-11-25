import { env } from "cloudflare:test";
import {
  claudePlanLimitText,
  Principal,
  type ProjectId,
  ProjectRepository,
  parseClaudePlanLimit,
  ThreadRepository,
  type UserId,
} from "@dx/domain";
import type { FlueObservation } from "@flue/runtime";
import { Effect, Schema } from "effect";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentAdmission } from "../../src/agents/admission.js";
import app from "../../src/app.js";
import { errorHandler } from "../../src/http/http-errors.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv, Bindings } from "../../src/http/types.js";
import { readSpaceRow } from "../../src/spaces/repository-d1.js";
import { spaceData } from "../../src/spaces/service.js";
import { TEST_CONFIG_ENCRYPTION_KEYS } from "../../src/testing/bindings.js";
import { recordFlueThreadActivity } from "../../src/threads/activity.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

/**
 * The owner can reset a Claude plan's limit on claude.ai, and only a Claude
 * Code run reads the plan's limits. A reading that blocks the plan is
 * trusted for two minutes; after that a person's message runs Claude Code
 * again, while schedules and other automations still wait for the reset.
 * When a run then finds room, the Threads waiting on that plan resume at
 * the next sweep instead of at the old reset.
 */

const origin = "http://dx.test";
const password = "claude-recheck-password-1234";
const bindings: Bindings = {
  DB: env.DB,
  DX_ENV: "local",
  DX_AUTH_URL: origin,
  DX_AUTH_TRUSTED_ORIGINS: origin,
  DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
  DX_SIGNUP_ENABLED: "true",
  BETTER_AUTH_SECRET: "claude-recheck-secret-0000000000000000",
  BYOK_CREDENTIAL_COORDINATOR: env.BYOK_CREDENTIAL_COORDINATOR,
};

const TOKEN = `sk-ant-oat01-${"r".repeat(48)}`;
const MODEL = "claude-code/claude-opus-5-5";
const hour = 3_600;
const now = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (request.url === "https://api.anthropic.com/v1/models?limit=1")
      return Response.json({ data: [{ id: "claude-haiku-5-5" }] });
    return real(input, init);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const signup = async (email: string, index: number) => {
  const response = await app.request(
    "/api/auth/sign-up/email",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        "cf-connecting-ip": `198.51.100.${index}`,
      },
      body: JSON.stringify({ name: "Recheck Owner", email, password }),
    },
    bindings,
  );
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (cookie === undefined) throw new Error("Expected session cookie.");
  const user = await env.DB.prepare('SELECT id FROM "user" WHERE email = ?')
    .bind(email)
    .first<{ id: string }>();
  if (user === null) throw new Error("Expected user row.");
  return { cookie, userId: user.id };
};

const connectPlan = async (cookie: string) => {
  const response = await app.request(
    "/v1/settings/personal/model-routing/connections",
    {
      method: "POST",
      headers: { cookie, origin, "content-type": "application/json" },
      body: JSON.stringify({
        name: "Claude Pro/Max",
        kind: "provider",
        providerId: "claude-code",
        apiKey: TOKEN,
      }),
    },
    bindings,
  );
  expect(response.status).toBe(200);
};

const seedThread = async (
  userId: string,
  threadId: string,
  kind: "thread" | "space" = "thread",
) => {
  const projectId = threadId.replace(/^thr_/, "prj_");
  await runRepositories(
    Effect.gen(function* () {
      yield* (yield* ProjectRepository).insert(
        project(projectId, userId as UserId, `Recheck ${threadId}`),
      );
      yield* (yield* ThreadRepository).insert(
        thread(threadId, projectId as ProjectId, userId as UserId),
      );
    }),
  );
  await env.DB.prepare(
    "UPDATE threads SET model_selection = ?, kind = ? WHERE id = ?",
  )
    .bind(
      JSON.stringify({ kind: "model", model: MODEL, thinking: "high" }),
      kind,
      threadId,
    )
    .run();
};

const coordinator = (threadId: string) =>
  env.BYOK_CREDENTIAL_COORDINATOR.get(
    env.BYOK_CREDENTIAL_COORDINATOR.idFromName(`byok-${threadId}`),
  );

const post = async (threadId: string, path: string, body: unknown) => {
  const response = await coordinator(threadId).fetch(
    `https://coordinator${path}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
};

/** A new submission's route, as Flue asks for it before a turn runs. */
const resolve = (threadId: string, submissionId: string) =>
  post(threadId, "/resolve", { threadId, submissionId, recovery: false });

/** What Claude Code's `rate_limit_event` reported, observed `ago` seconds back. */
const report = (
  threadId: string,
  submissionId: string,
  reading: unknown,
  ago: number,
) =>
  post(threadId, "/claude-code-usage", {
    threadId,
    submissionId,
    canonical: MODEL,
    reading,
    observedAt: now() - ago,
  });

const weekUsedUp = (resetsAt: number) => ({
  status: "rejected",
  limit: { id: "seven_day", resetsAt },
  windows: [{ id: "seven_day", utilization: 1, resetsAt }],
  extraUsage: {
    status: "rejected",
    inUse: false,
    disabledReason: "org_level_disabled",
  },
});

const weekReset = (resetsAt: number) => ({
  status: "allowed",
  limit: { id: "five_hour", resetsAt: now() + 5 * hour },
  windows: [
    { id: "five_hour", utilization: 0, resetsAt: now() + 5 * hour },
    { id: "seven_day", utilization: 0, resetsAt },
  ],
  extraUsage: {
    status: "rejected",
    inUse: false,
    disabledReason: "org_level_disabled",
  },
});

/** The turn settles failed on the limit; the Thread waits for its reset. */
const failOnLimit = (threadId: string, submissionId: string, text: string) =>
  recordFlueThreadActivity(
    {
      type: "submission_settled",
      instanceId: threadId,
      submissionId,
      timestamp: new Date().toISOString(),
      outcome: "failed",
      error: { message: text },
    } as unknown as FlueObservation,
    {
      id: "fixture",
      agentName: "dx",
      env: { DB: env.DB, REALTIME_HUB: env.REALTIME_HUB },
    } as never,
  );

/** A message sent through dx's real admission stack, by `userId` or a schedule. */
const sendMessage = (
  userId: string,
  threadId: string,
  body: string,
  automation?: "schedule",
) => {
  const routes = new Hono<AppEnv>();
  routes.use("*", requestId);
  routes.use("*", async (context, next) => {
    context.set(
      "principal",
      Schema.decodeUnknownSync(Principal)({
        userId,
        credentialScopes: ["personal", "workspace"],
      }),
    );
    if (automation !== undefined)
      context.set("messageAutomation", automation as never);
    await next();
  });
  const flue = new Hono<AppEnv>();
  flue.post("/:threadId", (context) =>
    context.json({ submissionId: "sub-admitted" }, 202),
  );
  routes.route(
    "/v1/agents/dx",
    useAgentAdmission(new Hono<AppEnv>()).route("/", flue),
  );
  routes.onError(errorHandler);
  return routes.request(
    `/v1/agents/dx/${threadId}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "user", body, idempotencyKey: body }),
    },
    bindings,
  );
};

const waitRow = (threadId: string) =>
  env.DB.prepare(
    "SELECT resets_at, limit_text FROM thread_plan_wait WHERE thread_id = ?",
  )
    .bind(threadId)
    .first<{ resets_at: number; limit_text: string | null }>();

describe("A Claude plan the owner reset on claude.ai", () => {
  it("runs again on a person's message once its blocking reading is two minutes old, and resumes the plan's waiting Threads", async () => {
    const { cookie, userId } = await signup("claude-recheck@example.com", 181);
    await connectPlan(cookie);
    const threadId = "thr_00000000-0000-4000-8000-00000000c181";
    const waiting = "thr_00000000-0000-4000-8000-00000000c182";
    await seedThread(userId, threadId);
    await seedThread(userId, waiting);
    // Both Threads take the plan on their first submission.
    expect((await resolve(threadId, "sub-first")).status).toBe(200);
    expect((await resolve(waiting, "sub-first")).status).toBe(200);

    // A run finds the weekly limit used up, until tomorrow.
    const resetsAt = now() + 20 * hour;
    expect(
      (await report(threadId, "sub-first", weekUsedUp(resetsAt), 0)).status,
    ).toBe(200);
    const limitText = claudePlanLimitText({
      window: "seven_day",
      resetsAt,
      cause: "exhausted",
    });
    await failOnLimit(threadId, "sub-first", limitText);
    await failOnLimit(waiting, "sub-first", limitText);
    expect(await waitRow(waiting)).toEqual({
      resets_at: resetsAt,
      limit_text: limitText,
    });

    // Fresh, the reading holds: a person's message is refused before
    // Claude Code starts.
    expect((await sendMessage(userId, threadId, "Go on")).status).toBe(202);
    const fresh = await resolve(threadId, "sub-fresh");
    expect(fresh.status).not.toBe(200);
    expect(parseClaudePlanLimit(JSON.stringify(fresh.body))).toMatchObject({
      window: "seven_day",
      resetsAt,
    });

    // Three minutes later (the reading, as stored, is that old) the owner
    // has reset the limit on claude.ai. A schedule's wake still waits.
    expect(
      (await report(threadId, "sub-first", weekUsedUp(resetsAt), 180)).status,
    ).toBe(200);
    await env.DB.prepare(
      "UPDATE claude_code_plan SET usage = json_set(usage, '$.observedAt', ?)",
    )
      .bind(now() - 180)
      .run();
    expect(
      (await sendMessage(userId, threadId, "Nightly report", "schedule"))
        .status,
    ).toBe(202);
    expect((await resolve(threadId, "sub-schedule")).status).not.toBe(200);

    // The owner's message runs Claude Code again.
    expect((await sendMessage(userId, threadId, "I reset it")).status).toBe(
      202,
    );
    expect((await resolve(threadId, "sub-person")).status).toBe(200);
    const credential = await post(threadId, "/claude-code-credential", {
      threadId,
      submissionId: "sub-person",
      canonical: MODEL,
    });
    expect(credential.status).toBe(200);
    expect(credential.body.plan).not.toHaveProperty("blockedUntil");

    // That run reads the plan with room: the other Thread waiting on it
    // is due at the next sweep, not tomorrow.
    expect(
      (await report(threadId, "sub-person", weekReset(resetsAt), 0)).status,
    ).toBe(200);
    expect((await waitRow(waiting))?.resets_at).toBeLessThanOrEqual(now());
  });

  it("blocks again when the plan is still used up", async () => {
    const { cookie, userId } = await signup("claude-still@example.com", 182);
    await connectPlan(cookie);
    const threadId = "thr_00000000-0000-4000-8000-00000000c184";
    await seedThread(userId, threadId);
    expect((await resolve(threadId, "sub-first")).status).toBe(200);
    const resetsAt = now() + 3 * hour;
    expect(
      (await report(threadId, "sub-first", weekUsedUp(resetsAt), 0)).status,
    ).toBe(200);
    await env.DB.prepare(
      "UPDATE claude_code_plan SET usage = json_set(usage, '$.observedAt', ?)",
    )
      .bind(now() - 300)
      .run();

    // The message rechecks; the run's reading says the plan is still used
    // up, and the next message within two minutes does not run again.
    expect((await sendMessage(userId, threadId, "Try again")).status).toBe(202);
    expect((await resolve(threadId, "sub-recheck")).status).toBe(200);
    expect(
      (await report(threadId, "sub-recheck", weekUsedUp(resetsAt), 0)).status,
    ).toBe(200);
    expect((await sendMessage(userId, threadId, "And again")).status).toBe(202);
    expect((await resolve(threadId, "sub-again")).status).not.toBe(200);
  });

  it("shows a Space the limit its agent waits for", async () => {
    const { cookie, userId } = await signup("claude-space@example.com", 183);
    await connectPlan(cookie);
    const spaceId = "thr_00000000-0000-4000-8000-00000000c183";
    await seedThread(userId, spaceId, "space");
    const resetsAt = now() + 2 * hour;
    const limitText = claudePlanLimitText({
      window: "five_hour",
      resetsAt,
      cause: "not-started",
    });
    await failOnLimit(spaceId, "sub-space", limitText);
    const row = await readSpaceRow(env.DB, spaceId as never, userId as never);
    expect(row).not.toBeNull();
    const [space] = await spaceData(env.DB, row === null ? [] : [row]);
    expect(space?.planLimit).toBe(limitText);
    expect(parseClaudePlanLimit(space?.planLimit ?? "")).toEqual({
      window: "five_hour",
      resetsAt,
      cause: "not-started",
    });
  });
});
