import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../src/app.js";
import type { Bindings } from "../../src/http/types.js";
import { TEST_CONFIG_ENCRYPTION_KEYS } from "../../src/testing/bindings.js";

/**
 * #1668: two Threads were archived while a Claude Code turn ran, with
 * messages queued behind it. Archiving stopped the Orb, Flue's recovery
 * asked for the plan token again, and the token check refused it because
 * the Thread was archived. The refusal said the Claude Pro/Max connection
 * was removed and told the owner to reconnect a plan that was connected
 * and serving other Threads.
 *
 * This replays that sequence against the real routes and the real
 * credential coordinator: the Thread's plan stays connected throughout.
 */

const origin = "http://dx.test";
const bindings: Bindings = {
  DB: env.DB,
  DX_ENV: "local",
  DX_AUTH_URL: origin,
  DX_AUTH_TRUSTED_ORIGINS: origin,
  DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
  DX_SIGNUP_ENABLED: "true",
  BETTER_AUTH_SECRET: "claude-code-archived-thread-secret-00",
  BYOK_CREDENTIAL_COORDINATOR: env.BYOK_CREDENTIAL_COORDINATOR,
};

// Fake tokens of the real shape; no real Claude token is ever used.
const PLAN_1 = `sk-ant-oat01-${"a".repeat(48)}`;
const PLAN_2 = `sk-ant-oat01-${"b".repeat(48)}`;
const MODEL = "claude-code/claude-opus-5-5";

beforeEach(() => {
  const real = globalThis.fetch;
  // Saving a plan asks Anthropic's model list whether the token is valid.
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (!new URL(request.url).hostname.endsWith("anthropic.com"))
      return real(input, init);
    return Response.json({ data: [{ id: "claude-haiku-5-5" }] });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const signup = async (email: string) => {
  const response = await app.request(
    "/api/auth/sign-up/email",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        "cf-connecting-ip": "198.51.100.168",
      },
      body: JSON.stringify({
        name: "Plan Owner",
        email,
        password: "claude-archived-password-1234",
      }),
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

const call = (path: string, cookie: string, method = "GET", body?: unknown) =>
  app.request(
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
  );

const connectPlan = async (cookie: string, name: string, apiKey: string) => {
  const response = await call(
    "/v1/settings/personal/model-routing/connections",
    cookie,
    "POST",
    { name, kind: "provider", providerId: "claude-code", apiKey },
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { data: { id: string } }).data.id;
};

const coordinatorPost = async (
  threadId: string,
  path: string,
  body: unknown,
) => {
  const stub = env.BYOK_CREDENTIAL_COORDINATOR.get(
    env.BYOK_CREDENTIAL_COORDINATOR.idFromName(`byok-${threadId}`),
  );
  const response = await stub.fetch(`https://coordinator${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as never };
};

/** A Thread on Claude Code, bound to one plan as Core binds it. */
const seedThread = async (
  userId: string,
  threadId: string,
  connectionId: string,
) => {
  const at = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO projects (id, owner_user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(`prj_${threadId.slice(4)}`, userId, "Plan 2 work", at, at),
    env.DB.prepare(
      `INSERT INTO threads (id, project_id, owner_user_id, model_selection,
         lifecycle_state, claude_connection_id, claude_connection_bound_at,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
    ).bind(
      threadId,
      `prj_${threadId.slice(4)}`,
      userId,
      JSON.stringify({ kind: "model", model: MODEL, thinking: "high" }),
      connectionId,
      at,
      at,
      at,
    ),
  ]);
};

const binding = (threadId: string) =>
  env.DB.prepare("SELECT claude_connection_id FROM threads WHERE id = ?")
    .bind(threadId)
    .first<string>("claude_connection_id");

describe("a Claude Code Thread archived mid-turn (#1668)", () => {
  it("says the Thread is archived, not that its connected plan was removed, and continues on the same plan once restored", async () => {
    const { cookie, userId } = await signup("claude-archived@example.com");
    const plan1 = await connectPlan(cookie, "Claude Pro/Max", PLAN_1);
    const plan2 = await connectPlan(cookie, "Claude Pro/Max 2", PLAN_2);
    const threadId = "thr_00000000-0000-4000-8000-000000001668";
    await seedThread(userId, threadId, plan2);

    // A turn runs on plan 2 and gets its token.
    const running = { threadId, submissionId: `${threadId}-running` };
    const route = { ...running, canonical: MODEL };
    expect((await coordinatorPost(threadId, "/resolve", running)).status).toBe(
      200,
    );
    expect(
      await coordinatorPost(threadId, "/claude-code-credential", route),
    ).toMatchObject({ status: 200, body: { token: PLAN_2 } });

    // The owner archives the Thread while that turn is still running. In
    // tests the Orb cannot be stopped (503), but the archive commits.
    await call(`/v1/threads/${threadId}/archive`, cookie, "PATCH", {
      archived: true,
    });
    const archived = await env.DB.prepare(
      "SELECT lifecycle_state FROM threads WHERE id = ?",
    )
      .bind(threadId)
      .first<string>("lifecycle_state");
    expect(archived).toBe("archived");

    // The turn's recovery asks for the token again. Both plans are still
    // connected and enabled; the refusal names the real cause.
    const refused = await coordinatorPost(
      threadId,
      "/claude-code-credential",
      route,
    );
    expect(refused).toEqual({
      status: 400,
      body: {
        code: "THREAD_ARCHIVED",
        error: {
          code: "THREAD_ARCHIVED",
          message: "This Thread is archived. Restore it to continue.",
        },
      },
    });
    expect(JSON.stringify(refused.body)).not.toMatch(/removed|deleted/i);
    const plans = await env.DB.prepare(
      "SELECT id, enabled FROM model_connection WHERE id IN (?, ?) ORDER BY id",
    )
      .bind(plan1, plan2)
      .all<{ id: string; enabled: number }>();
    expect(plans.results.map(({ enabled }) => enabled)).toEqual([1, 1]);

    // Archiving keeps the Thread on its plan.
    expect(await binding(threadId)).toBe(plan2);

    // Restored, the Thread continues on plan 2, never on another plan: the
    // interrupted submission and a new message both get plan 2's token.
    const restored = await call(
      `/v1/threads/${threadId}/archive`,
      cookie,
      "PATCH",
      { archived: false },
    );
    expect(restored.status).toBe(200);
    expect(await binding(threadId)).toBe(plan2);
    expect(
      await coordinatorPost(threadId, "/claude-code-credential", route),
    ).toMatchObject({ status: 200, body: { token: PLAN_2 } });
    const next = { threadId, submissionId: `${threadId}-after-restore` };
    expect((await coordinatorPost(threadId, "/resolve", next)).status).toBe(
      200,
    );
    expect(
      await coordinatorPost(threadId, "/claude-code-credential", {
        ...next,
        canonical: MODEL,
      }),
    ).toMatchObject({ status: 200, body: { token: PLAN_2 } });
  });

  it("still reports a plan the owner really disconnected as removed", async () => {
    const { cookie, userId } = await signup("claude-removed@example.com");
    const plan = await connectPlan(cookie, "Claude Pro/Max", PLAN_1);
    const threadId = "thr_00000000-0000-4000-8000-000000001669";
    await seedThread(userId, threadId, plan);
    const running = { threadId, submissionId: `${threadId}-running` };
    expect((await coordinatorPost(threadId, "/resolve", running)).status).toBe(
      200,
    );

    await env.DB.prepare("UPDATE model_connection SET enabled = 0 WHERE id = ?")
      .bind(plan)
      .run();
    expect(
      await coordinatorPost(threadId, "/claude-code-credential", {
        ...running,
        canonical: MODEL,
      }),
    ).toMatchObject({ status: 400, body: { code: "CONNECTION_REMOVED" } });
  });
});
