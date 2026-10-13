import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import app from "../../src/app.js";
import type { Bindings } from "../../src/http/types.js";
import { claudeCodeTokenFetch } from "../../src/settings/model-routing/claude-code-token.js";
import { TEST_CONFIG_ENCRYPTION_KEYS } from "../../src/testing/bindings.js";

/**
 * A Claude Pro/Max plan's limits and extra usage choice, through the
 * settings API and the credential coordinator that Claude Code runs and
 * title calls use. Anthropic is replaced by a fake that answers the token
 * check and Messages calls with the plan's rate-limit headers.
 */

const origin = "http://dx.test";
const password = "claude-plan-password-1234";
const bindings: Bindings = {
  DB: env.DB,
  DX_ENV: "local",
  DX_AUTH_URL: origin,
  DX_AUTH_TRUSTED_ORIGINS: origin,
  DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
  DX_SIGNUP_ENABLED: "true",
  BETTER_AUTH_SECRET: "claude-plan-secret-000000000000000000",
  BYOK_CREDENTIAL_COORDINATOR: env.BYOK_CREDENTIAL_COORDINATOR,
};

const TOKEN = `sk-ant-oat01-${"p".repeat(48)}`;
const NEW_TOKEN = `sk-ant-oat01-${"n".repeat(48)}`;
const MODEL = "claude-code/claude-opus-5-5";
const hour = 3_600;
const now = () => Math.floor(Date.now() / 1000);

const messageCalls: { model: unknown }[] = [];
let planHeaders: Record<string, string> = {};

claudeCodeTokenFetch.current = async (input, init) => {
  const request = new Request(input, init);
  const authorization = request.headers.get("authorization");
  if (
    authorization !== `Bearer ${TOKEN}` &&
    authorization !== `Bearer ${NEW_TOKEN}`
  )
    return Response.json({ type: "error" }, { status: 401 });
  if (request.url.startsWith("https://api.anthropic.com/v1/models"))
    return Response.json({ data: [{ id: "claude-haiku-5-5" }] });
  const body = (await request.json()) as { model: unknown };
  messageCalls.push({ model: body.model });
  return Response.json(
    {
      content: [{ type: "text", text: "Plan usage card" }],
      usage: { input_tokens: 40, output_tokens: 4 },
    },
    { headers: planHeaders },
  );
};

afterEach(() => {
  messageCalls.length = 0;
  planHeaders = {};
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
      body: JSON.stringify({ name: "Plan Owner", email, password }),
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

const base = "/v1/settings/personal/model-routing";

interface Plan {
  allowExtraUsage: boolean;
  usage?: {
    status: string;
    limit?: { id: string; resetsAt: number };
    windows: { id: string; utilization: number; resetsAt: number }[];
    extraUsage: { status?: string; resetsAt?: number; inUse: boolean };
    observedAt: number;
  };
}

const claudeConnection = async (cookie: string) => {
  const body = (await (await call(`${base}/connections`, cookie)).json()) as {
    data: {
      connections: { id: string; providerId: string; claudePlan?: Plan }[];
    };
  };
  const connection = body.data.connections.find(
    ({ providerId }) => providerId === "claude-code",
  );
  if (connection === undefined) throw new Error("Expected Claude connection.");
  return connection;
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
  return { status: response.status, body: (await response.json()) as never };
};

const seedThread = async (userId: string, threadId: string, model = MODEL) => {
  const at = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO projects (id, owner_user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(`${threadId}-project`, userId, `Plan ${threadId}`, at, at),
    env.DB.prepare(
      "INSERT INTO threads (id, project_id, owner_user_id, model_selection, lifecycle_state, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)",
    ).bind(
      threadId,
      `${threadId}-project`,
      userId,
      JSON.stringify({ kind: "model", model, thinking: "high" }),
      at,
      at,
    ),
  ]);
};

const title = (threadId: string, userId: string) =>
  post(threadId, "/complete", {
    threadId,
    ownerUserId: userId,
    selection: { kind: "model", model: MODEL, thinking: "high" },
    systemPrompt: "Title the message.",
    message: "<user_message>\nShow plan usage\n</user_message>",
    maxTokens: 64,
  });

describe("Claude Pro/Max plan usage", () => {
  it("records plan limits, keeps Claude Code off extra usage by default, and lets the owner allow it", async () => {
    const { cookie, userId } = await signup("claude-plan@example.com", 171);
    const threadId = "claude-plan-thread";
    await seedThread(userId, threadId);
    const connected = await call(`${base}/connections`, cookie, "POST", {
      name: "Claude Pro/Max",
      kind: "provider",
      providerId: "claude-code",
      apiKey: TOKEN,
    });
    expect(connected.status).toBe(200);

    // A new plan has no readings and stays on the subscription.
    const fresh = await claudeConnection(cookie);
    expect(fresh.claudePlan).toEqual({ allowExtraUsage: false });

    // The title call reads the plan's limits from Anthropic's headers.
    const fiveHourReset = now() + 2 * hour;
    const weekReset = now() + 4 * 24 * hour;
    planHeaders = {
      "anthropic-ratelimit-unified-status": "allowed",
      "anthropic-ratelimit-unified-representative-claim": "five_hour",
      "anthropic-ratelimit-unified-reset": String(fiveHourReset),
      "anthropic-ratelimit-unified-5h-utilization": "0.42",
      "anthropic-ratelimit-unified-5h-reset": String(fiveHourReset),
      "anthropic-ratelimit-unified-7d-utilization": "0.18",
      "anthropic-ratelimit-unified-7d-reset": String(weekReset),
      "anthropic-ratelimit-unified-overage-status": "allowed",
      "anthropic-ratelimit-unified-overage-in-use": "false",
    };
    const titled = await title(threadId, userId);
    expect(titled).toEqual({
      status: 200,
      body: { text: "Plan usage card" },
    });
    expect(messageCalls).toEqual([{ model: "claude-haiku-5-5" }]);
    const observed = (await claudeConnection(cookie)).claudePlan;
    expect(observed).toMatchObject({
      allowExtraUsage: false,
      usage: {
        status: "allowed",
        limit: { id: "five_hour", resetsAt: fiveHourReset },
        windows: [
          { id: "five_hour", utilization: 0.42, resetsAt: fiveHourReset },
          { id: "seven_day", utilization: 0.18, resetsAt: weekReset },
        ],
        extraUsage: { status: "allowed", inUse: false },
      },
    });
    expect(observed?.usage?.observedAt).toBeGreaterThanOrEqual(now() - 60);

    // A Claude Code run gets the token with the plan's choice.
    const submissionId = "claude-plan-submission";
    expect(
      (
        await post(threadId, "/resolve", {
          threadId,
          submissionId,
          recovery: false,
        })
      ).status,
    ).toBe(200);
    const route = { threadId, submissionId, canonical: MODEL };
    expect(await post(threadId, "/claude-code-credential", route)).toEqual({
      status: 200,
      body: {
        token: TOKEN,
        plan: { allowExtraUsage: false, limitWindow: "five_hour" },
      },
    });

    // The run reports that the 5-hour window is used up and extra usage
    // is paying: dx keeps the plan blocked until the window resets.
    const overage = {
      status: "rejected",
      limit: { id: "five_hour", resetsAt: fiveHourReset },
      windows: [{ id: "five_hour", utilization: 1, resetsAt: fiveHourReset }],
      extraUsage: { status: "allowed", inUse: true },
    };
    expect(
      await post(threadId, "/claude-code-usage", {
        ...route,
        reading: overage,
        observedAt: now(),
      }),
    ).toEqual({
      status: 200,
      body: {
        plan: {
          allowExtraUsage: false,
          blockedUntil: fiveHourReset,
          limitWindow: "five_hour",
        },
      },
    });
    // The weekly window the run did not report keeps its last value.
    expect((await claudeConnection(cookie)).claudePlan?.usage).toMatchObject({
      status: "rejected",
      windows: [
        { id: "five_hour", utilization: 1 },
        { id: "seven_day", utilization: 0.18 },
      ],
      extraUsage: { inUse: true },
    });
    expect(
      (await post(threadId, "/claude-code-credential", route)).body,
    ).toMatchObject({ plan: { blockedUntil: fiveHourReset } });
    // A title is never worth extra usage: Anthropic is not called.
    messageCalls.length = 0;
    expect((await title(threadId, userId)).status).toBe(502);
    expect(messageCalls).toEqual([]);

    // A malformed reading is refused and changes nothing.
    expect(
      (
        await post(threadId, "/claude-code-usage", {
          ...route,
          reading: { status: "unlimited" },
          observedAt: now(),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post(threadId, "/claude-code-usage", {
          ...route,
          reading: overage,
        })
      ).status,
    ).toBe(400);

    // Another run's older reading, sent again on its next step, does not
    // replace the newer one: the plan stays blocked.
    expect(
      await post(threadId, "/claude-code-usage", {
        ...route,
        reading: {
          status: "allowed",
          limit: { id: "five_hour", resetsAt: fiveHourReset },
          windows: [
            { id: "five_hour", utilization: 0.6, resetsAt: fiveHourReset },
          ],
          extraUsage: { status: "allowed", inUse: false },
        },
        observedAt: now() - 20 * 60,
      }),
    ).toMatchObject({
      status: 200,
      body: { plan: { blockedUntil: fiveHourReset } },
    });
    expect((await claudeConnection(cookie)).claudePlan?.usage).toMatchObject({
      status: "rejected",
      windows: [{ id: "five_hour", utilization: 1 }, { id: "seven_day" }],
    });

    // The owner allows extra usage: runs start again.
    const allowed = await call(
      `${base}/connections/${fresh.id}/claude-plan`,
      cookie,
      "POST",
      { allowExtraUsage: true },
    );
    expect(allowed.status).toBe(200);
    expect(
      ((await allowed.json()) as { data: { claudePlan: Plan } }).data.claudePlan
        .allowExtraUsage,
    ).toBe(true);
    expect(await post(threadId, "/claude-code-credential", route)).toEqual({
      status: 200,
      body: {
        token: TOKEN,
        plan: { allowExtraUsage: true, limitWindow: "five_hour" },
      },
    });

    // A replaced token may be another account: its readings are dropped,
    // the extra usage choice stays.
    const replaced = await call(
      `${base}/connections/${fresh.id}`,
      cookie,
      "PATCH",
      { apiKey: NEW_TOKEN },
    );
    expect(replaced.status).toBe(200);
    expect((await claudeConnection(cookie)).claudePlan).toEqual({
      allowExtraUsage: true,
    });

    // Only a Claude Pro/Max connection has extra usage.
    const custom = await call(`${base}/connections`, cookie, "POST", {
      name: "Custom",
      kind: "custom",
      providerId: "dx-custom",
      baseUrl: "https://models.example.com/v1",
      format: "openai-completions",
      models: [{ canonical: "openai/gpt-6-astra" }],
      apiKey: "sk-custom",
    });
    expect(custom.status).toBe(200);
    const customId = ((await custom.json()) as { data: { id: string } }).data
      .id;
    const refused = await call(
      `${base}/connections/${customId}/claude-plan`,
      cookie,
      "POST",
      { allowExtraUsage: true },
    );
    expect(refused.status).toBe(400);

    // Deleting the connection deletes its plan state.
    expect(
      (await call(`${base}/connections/${fresh.id}`, cookie, "DELETE")).status,
    ).toBe(200);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM claude_code_plan WHERE connection_id = ?",
      )
        .bind(fresh.id)
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });
  });

  it("holds only the model a per-model weekly limit covers", async () => {
    const { cookie, userId } = await signup(
      "claude-plan-fable@example.com",
      172,
    );
    const connected = await call(`${base}/connections`, cookie, "POST", {
      name: "Claude Pro/Max",
      kind: "provider",
      providerId: "claude-code",
      apiKey: TOKEN,
    });
    expect(connected.status).toBe(200);
    const fable = "claude-plan-fable-thread";
    const opus = "claude-plan-opus-thread";
    const FABLE = "claude-code/claude-fable-5-1";
    await seedThread(userId, fable, FABLE);
    await seedThread(userId, opus);
    const routeOf = async (threadId: string, canonical: string) => {
      const submissionId = `${threadId}-submission`;
      expect(
        (
          await post(threadId, "/resolve", {
            threadId,
            submissionId,
            recovery: false,
          })
        ).status,
      ).toBe(200);
      return { threadId, submissionId, canonical };
    };
    const fableRoute = await routeOf(fable, FABLE);
    const opusRoute = await routeOf(opus, MODEL);

    // The weekly Fable allowance ran out and extra usage pays for Fable;
    // the plan's account-wide windows still have room.
    const fableReset = now() + 3 * 24 * hour;
    const reading = {
      status: "rejected",
      limit: { id: "seven_day_overage_included", resetsAt: fableReset },
      windows: [
        { id: "five_hour", utilization: 0.3, resetsAt: now() + hour },
        { id: "seven_day", utilization: 0.5, resetsAt: fableReset },
        {
          id: "seven_day_overage_included",
          utilization: 1,
          resetsAt: fableReset,
        },
      ],
      extraUsage: { status: "allowed", inUse: true },
    };
    expect(
      await post(fable, "/claude-code-usage", {
        ...fableRoute,
        reading,
        observedAt: now(),
      }),
    ).toEqual({
      status: 200,
      body: {
        plan: {
          allowExtraUsage: false,
          blockedUntil: fableReset,
          limitWindow: "seven_day_overage_included",
        },
      },
    });
    // Fable Threads wait for the reset; Opus Threads and Haiku titles run.
    expect(
      (await post(fable, "/claude-code-credential", fableRoute)).body,
    ).toMatchObject({ plan: { blockedUntil: fableReset } });
    expect(await post(opus, "/claude-code-credential", opusRoute)).toEqual({
      status: 200,
      body: { token: TOKEN, plan: { allowExtraUsage: false } },
    });
    expect((await title(opus, userId)).status).toBe(200);
    expect(messageCalls).toEqual([{ model: "claude-haiku-5-5" }]);
  });
});
