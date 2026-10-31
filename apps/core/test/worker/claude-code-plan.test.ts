import { env } from "cloudflare:test";
import { parseClaudePlanLimit } from "@dx/domain";
import { FlueError, type SandboxFactory } from "@flue/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../src/app.js";
import type { Bindings } from "../../src/http/types.js";
import { makeAgentRuntimeComposition } from "../../src/runtime/agent-composition.js";
import { TEST_CONFIG_ENCRYPTION_KEYS } from "../../src/testing/bindings.js";

/**
 * A Claude Pro/Max plan's limits and extra usage choice, through the
 * settings API and the credential coordinator that Claude Code runs use.
 * Only Claude Code runs report the limits; Core calls Anthropic only for
 * the model list check when a plan is saved.
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

const anthropicCalls: string[] = [];

beforeEach(() => {
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (!new URL(request.url).hostname.endsWith("anthropic.com"))
      return real(input, init);
    // Saving a plan asks the model list whether the token is valid.
    if (request.url === "https://api.anthropic.com/v1/models?limit=1")
      return Response.json({ data: [{ id: "claude-haiku-5-5" }] });
    anthropicCalls.push(request.url);
    return Response.json({ type: "error" }, { status: 500 });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  expect(anthropicCalls).toEqual([]);
  anthropicCalls.length = 0;
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
    extraUsage: {
      status?: string;
      resetsAt?: number;
      inUse: boolean;
      disabledReason?: string;
    };
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

    // A Claude Code Thread's title comes from Claude Code itself, never from
    // the Messages API on the plan's token.
    expect(await title(threadId, userId)).toEqual({
      status: 409,
      body: { code: "CLAUDE_CODE_TITLE_DEFERRED" },
    });

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
      body: { token: TOKEN, plan: { allowExtraUsage: false } },
    });

    // The run (or its title answer) reports the plan's limits.
    const fiveHourReset = now() + 2 * hour;
    const weekReset = now() + 4 * 24 * hour;
    expect(
      (
        await post(threadId, "/claude-code-usage", {
          ...route,
          reading: {
            status: "allowed",
            limit: { id: "five_hour", resetsAt: fiveHourReset },
            windows: [
              { id: "five_hour", utilization: 0.42, resetsAt: fiveHourReset },
              { id: "seven_day", utilization: 0.18, resetsAt: weekReset },
            ],
            extraUsage: { status: "allowed", inUse: false },
          },
          observedAt: now(),
        })
      ).status,
    ).toBe(200);
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
    expect(
      (await post(threadId, "/claude-code-credential", route)).body,
    ).toEqual({
      token: TOKEN,
      plan: { allowExtraUsage: false, limitWindow: "five_hour" },
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
    // Fable Threads wait for the reset; Opus Threads run.
    expect(
      (await post(fable, "/claude-code-credential", fableRoute)).body,
    ).toMatchObject({ plan: { blockedUntil: fableReset } });
    expect(await post(opus, "/claude-code-credential", opusRoute)).toEqual({
      status: 200,
      body: { token: TOKEN, plan: { allowExtraUsage: false } },
    });
  });

  it("refuses a new Claude Code submission at /resolve while the plan is blocked, before the Orb wakes", async () => {
    const { cookie, userId } = await signup(
      "claude-plan-resolve@example.com",
      173,
    );
    expect(
      (
        await call(`${base}/connections`, cookie, "POST", {
          name: "Claude Pro/Max",
          kind: "provider",
          providerId: "claude-code",
          apiKey: TOKEN,
        })
      ).status,
    ).toBe(200);
    const threadId = "claude-plan-resolve-thread";
    await seedThread(userId, threadId);
    const running = {
      threadId,
      submissionId: "claude-plan-resolve-running",
      recovery: false,
    };
    expect((await post(threadId, "/resolve", running)).status).toBe(200);
    // The run reports the 5-hour window used up on extra usage.
    const reset = now() + 2 * hour;
    expect(
      (
        await post(threadId, "/claude-code-usage", {
          threadId,
          submissionId: running.submissionId,
          canonical: MODEL,
          reading: {
            status: "rejected",
            limit: { id: "five_hour", resetsAt: reset },
            windows: [{ id: "five_hour", utilization: 1, resetsAt: reset }],
            extraUsage: { status: "allowed", inUse: true },
          },
          observedAt: now(),
        })
      ).body,
    ).toMatchObject({ plan: { blockedUntil: reset } });

    // The running submission keeps its route; a new one is refused with the
    // text the limit card shows.
    expect((await post(threadId, "/resolve", running)).status).toBe(200);
    const refused = await post(threadId, "/resolve", {
      threadId,
      submissionId: "claude-plan-resolve-next",
      recovery: false,
    });
    expect(refused.status).toBe(400);
    const limit = {
      window: "five_hour",
      resetsAt: Math.floor(reset / 60) * 60,
      cause: "not-started",
    };
    expect(
      parseClaudePlanLimit((refused.body as { message: string }).message),
    ).toEqual(limit);

    // The agent's prompt data resolution fails with that text, before any
    // workspace is created.
    const createSandbox = () => {
      throw new Error("The workspace must not wake.");
    };
    const runtime = makeAgentRuntimeComposition(
      {
        DB: env.DB,
        DX_RUNTIME_MODE: "local",
        DX_LOCAL_CLAUDE_CODE: "1",
        BYOK_CREDENTIAL_COORDINATOR: env.BYOK_CREDENTIAL_COORDINATOR,
      },
      { createSandbox } as unknown as SandboxFactory,
    );
    const failure = await runtime.model
      .resolvePromptData({
        instanceId: threadId,
        agentName: "dx",
        scope: { kind: "prompt", submissionId: "claude-plan-resolve-third" },
        signal: new AbortController().signal,
        recovery: false,
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    // Flue settles any other error as a generic internal error.
    expect(failure).toBeInstanceOf(FlueError);
    expect(parseClaudePlanLimit((failure as Error).message)).toEqual(limit);
  });

  it("puts each new Thread on the first plan in order that is not used up, and keeps it there", async () => {
    const { cookie, userId } = await signup(
      "claude-plan-fallback@example.com",
      175,
    );
    const connect = async (name: string, apiKey: string) => {
      const response = await call(`${base}/connections`, cookie, "POST", {
        name,
        kind: "provider",
        providerId: "claude-code",
        apiKey,
      });
      expect(response.status).toBe(200);
      return ((await response.json()) as { data: { id: string } }).data.id;
    };
    const first = await connect("Claude Pro/Max", TOKEN);
    const second = await connect("Claude Pro/Max 2", NEW_TOKEN);
    const reorder = async (orderedIds: string[]) =>
      expect(
        (
          await call(`${base}/connections/reorder`, cookie, "POST", {
            orderedIds,
          })
        ).status,
      ).toBe(200);
    let submissions = 0;
    const submit = async (threadId: string) => {
      submissions += 1;
      const route = {
        threadId,
        submissionId: `${threadId}-${submissions}`,
        canonical: MODEL,
      };
      const resolved = await post(threadId, "/resolve", {
        threadId,
        submissionId: route.submissionId,
        recovery: false,
      });
      return { resolved, route };
    };
    const tokenOf = async (threadId: string) => {
      const { resolved, route } = await submit(threadId);
      expect(resolved.status).toBe(200);
      const credential = await post(threadId, "/claude-code-credential", route);
      return { route, token: (credential.body as { token: string }).token };
    };
    const limitOf = async (threadId: string) => {
      const { resolved } = await submit(threadId);
      expect(resolved.status).toBe(400);
      return parseClaudePlanLimit(
        (resolved.body as { message: string }).message,
      )?.resetsAt;
    };
    const useUp = async (
      route: { threadId: string; submissionId: string; canonical: string },
      resetsAt: number,
    ) =>
      expect(
        (
          await post(route.threadId, "/claude-code-usage", {
            ...route,
            reading: {
              status: "rejected",
              limit: { id: "five_hour", resetsAt },
              windows: [{ id: "five_hour", utilization: 1, resetsAt }],
              extraUsage: { status: "allowed", inUse: true },
            },
            observedAt: now(),
          })
        ).status,
      ).toBe(200);
    const minute = (seconds: number) => Math.floor(seconds / 60) * 60;
    // A later reading with the window reset: the plan is open again.
    const reopen = async (route: {
      threadId: string;
      submissionId: string;
      canonical: string;
    }) =>
      expect(
        (
          await post(route.threadId, "/claude-code-usage", {
            ...route,
            reading: {
              status: "allowed",
              windows: [
                { id: "five_hour", utilization: 0.1, resetsAt: now() + hour },
              ],
              extraUsage: { status: "allowed", inUse: false },
            },
            observedAt: now(),
          })
        ).status,
      ).toBe(200);
    const boundTo = async (threadId: string) =>
      (
        await env.DB.prepare(
          "SELECT claude_connection_id FROM threads WHERE id = ?",
        )
          .bind(threadId)
          .first<{ claude_connection_id: string | null }>()
      )?.claude_connection_id;
    const [one, two, three, four] = [1, 2, 3, 4].map(
      (index) => `claude-plan-fallback-thread-${index}`,
    );
    for (const threadId of [one, two, three, four])
      await seedThread(userId, threadId);

    // A Thread starts on the first plan in order, and stays on it when the
    // order changes; a new Thread takes the new first plan.
    const onFirst = await tokenOf(one);
    expect(onFirst.token).toBe(TOKEN);
    expect(await boundTo(one)).toBe(first);
    await reorder([second, first]);
    expect((await tokenOf(one)).token).toBe(TOKEN);
    const onSecond = await tokenOf(two);
    expect(onSecond.token).toBe(NEW_TOKEN);
    expect(await boundTo(two)).toBe(second);

    // The first plan is used up. Its Thread waits for that plan's reset
    // instead of moving; a new Thread skips it for the second plan.
    await reorder([first, second]);
    const firstReset = now() + 2 * hour;
    await useUp(onFirst.route, firstReset);
    expect(await limitOf(one)).toBe(minute(firstReset));
    expect(await boundTo(one)).toBe(first);
    expect((await tokenOf(three)).token).toBe(NEW_TOKEN);
    expect(await boundTo(three)).toBe(second);

    // Both used up: a new Thread is refused with the limit of the plan that
    // resets first, not the first in order, and stays on no plan.
    const secondReset = now() + hour;
    await useUp(onSecond.route, secondReset);
    expect(await limitOf(four)).toBe(minute(secondReset));
    expect(await boundTo(four)).toBeNull();

    // Disabling the second plan holds its Threads: Thread two is refused
    // with the plan's name instead of moving to the first plan, which is
    // open again, and keeps its binding.
    await reopen(onFirst.route);
    expect(
      (
        await call(`${base}/connections/${second}/enabled`, cookie, "POST", {
          enabled: false,
        })
      ).status,
    ).toBe(200);
    const disabled = await submit(two);
    expect(disabled.resolved.status).toBe(400);
    expect(disabled.resolved.body).toEqual({
      code: "CLAUDE_PLAN_UNAVAILABLE",
      class: "account",
      message: expect.stringContaining('"Claude Pro/Max 2", which is disabled'),
    });
    expect(await boundTo(two)).toBe(second);
    // The agent's prompt data resolution fails with the same text, as a
    // FlueError so the settlement keeps it, stamped as an account failure
    // for the Thread's error card.
    const runtime = makeAgentRuntimeComposition(
      {
        DB: env.DB,
        DX_RUNTIME_MODE: "local",
        DX_LOCAL_CLAUDE_CODE: "1",
        BYOK_CREDENTIAL_COORDINATOR: env.BYOK_CREDENTIAL_COORDINATOR,
      },
      {
        createSandbox: () => {
          throw new Error("The workspace must not wake.");
        },
      } as unknown as SandboxFactory,
    );
    const failure = await runtime.model
      .resolvePromptData({
        instanceId: two,
        agentName: "dx",
        scope: { kind: "prompt", submissionId: `${two}-disabled-agent` },
        signal: new AbortController().signal,
        recovery: false,
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(FlueError);
    expect((failure as Error).message).toContain(
      '"Claude Pro/Max 2", which is disabled',
    );
    expect((failure as Error).message).toContain(
      "(dx_failure:account:CLAUDE_PLAN_UNAVAILABLE)",
    );
    // A new Thread skips the disabled plan for the first.
    const five = "claude-plan-fallback-thread-5";
    await seedThread(userId, five);
    expect((await tokenOf(five)).token).toBe(TOKEN);
    // Enabled again, Thread two is back on its own plan.
    expect(
      (
        await call(`${base}/connections/${second}/enabled`, cookie, "POST", {
          enabled: true,
        })
      ).status,
    ).toBe(200);
    await reopen(onSecond.route);
    expect((await tokenOf(two)).token).toBe(NEW_TOKEN);

    // Deleting the second plan holds its Threads too: Thread two has no
    // plan to run on and takes no other, while the first plan is open.
    expect(
      (await call(`${base}/connections/${second}`, cookie, "DELETE")).status,
    ).toBe(200);
    expect(await boundTo(two)).toBeNull();
    const removed = await submit(two);
    expect(removed.resolved.status).toBe(400);
    expect(removed.resolved.body).toEqual({
      code: "CLAUDE_PLAN_UNAVAILABLE",
      class: "account",
      message: expect.stringContaining("was removed"),
    });
    expect(await boundTo(two)).toBeNull();
    // The title completion, which runs without the Thread's route, holds too.
    expect((await title(two, userId)).status).toBe(400);
    expect(await boundTo(two)).toBeNull();
    // A Thread that never had a plan still takes the open one.
    const six = "claude-plan-fallback-thread-6";
    await seedThread(userId, six);
    expect((await tokenOf(six)).token).toBe(TOKEN);
  });

  it("keeps a Thread that ran before it had a plan on the plan of its last turn", async () => {
    const { cookie, userId } = await signup(
      "claude-plan-backfill@example.com",
      176,
    );
    const connect = async (name: string, apiKey: string) => {
      const response = await call(`${base}/connections`, cookie, "POST", {
        name,
        kind: "provider",
        providerId: "claude-code",
        apiKey,
      });
      expect(response.status).toBe(200);
      return ((await response.json()) as { data: { id: string } }).data.id;
    };
    const first = await connect("Claude Pro/Max", TOKEN);
    const second = await connect("Claude Pro/Max 2", NEW_TOKEN);
    const resolve = (threadId: string, submissionId: string) =>
      post(threadId, "/resolve", { threadId, submissionId, recovery: false });
    const planOf = async (threadId: string) =>
      env.DB.prepare(
        "SELECT claude_connection_id AS id, claude_connection_bound_at AS at FROM threads WHERE id = ?",
      )
        .bind(threadId)
        .first<{ id: string | null; at: string | null }>();
    // The first plan is used up, so a Thread without a plan would take the
    // second at its next message.
    const seeded = "claude-plan-backfill-seed";
    await seedThread(userId, seeded);
    expect((await resolve(seeded, `${seeded}-1`)).status).toBe(200);
    expect(
      (
        await post(seeded, "/claude-code-usage", {
          threadId: seeded,
          submissionId: `${seeded}-1`,
          canonical: MODEL,
          reading: {
            status: "rejected",
            limit: { id: "five_hour", resetsAt: now() + hour },
            windows: [
              { id: "five_hour", utilization: 1, resetsAt: now() + hour },
            ],
            extraUsage: { status: "allowed", inUse: true },
          },
          observedAt: now(),
        })
      ).status,
    ).toBe(200);

    // Threads from before migration 0103 ran turns with no plan recorded on
    // them; the usage ledger names each turn's connection.
    const ran = "claude-plan-backfill-ran";
    const neverRan = "claude-plan-backfill-never-ran";
    const planGone = "claude-plan-backfill-plan-gone";
    for (const threadId of [ran, neverRan, planGone])
      await seedThread(userId, threadId);
    const turn = async (
      threadId: string,
      connectionId: string,
      occurredAt: string,
    ) => {
      await env.DB.prepare(
        `INSERT INTO usage_event (
           id, kind, owner_user_id, thread_id, project_id, occurred_at,
           expires_at, outcome, turn_id, turn_purpose, connection_id,
           provider_id, model_id, model_route_version, model_profile_id,
           model_profile_version, model_configuration_revision,
           observed_provider_id, observed_provider_name, observed_model_id
         ) VALUES (?, 'model', ?, ?, ?, ?, ?, 'success', ?, 'agent', ?,
           'claude-code', 'claude-opus-5-5', 2, 'model', 1, 0,
           'claude-code', 'Claude Code', 'claude-opus-5-5')`,
      )
        .bind(
          `${threadId}-${occurredAt}`,
          userId,
          threadId,
          `${threadId}-project`,
          occurredAt,
          "2027-04-30T00:00:00.000Z",
          `${threadId}-turn-${occurredAt}`,
          connectionId,
        )
        .run();
    };
    // An earlier turn on the second plan, then the latest on the first.
    await turn(ran, second, "2026-10-29T10:00:00.000Z");
    await turn(ran, first, "2026-10-30T10:00:00.000Z");
    await turn(
      planGone,
      "mcon_deleted-before-0104",
      "2026-10-30T11:00:00.000Z",
    );

    // The backfill statement of migration 0104, as deployed, against the
    // pre-0103 state: no plan and no time on any of them.
    await env.DB.prepare(
      "UPDATE threads SET claude_connection_id = NULL, claude_connection_bound_at = NULL WHERE id IN (?, ?, ?, ?)",
    )
      .bind(seeded, ran, neverRan, planGone)
      .run();
    const migration = env.TEST_MIGRATIONS.find(({ name }) =>
      name.startsWith("0104_"),
    );
    if (migration === undefined) throw new Error("Expected migration 0104.");
    const backfill = migration.queries.filter(
      (query) =>
        query.includes("claude_connection_id IS NULL") &&
        query.includes("usage_event"),
    );
    expect(backfill).toHaveLength(1);
    await env.DB.prepare(backfill[0] ?? "").run();
    // The Thread that ran goes to the plan of its latest turn, used up or
    // not; one whose plan is gone, or that never ran, is left for `/resolve`.
    expect((await planOf(ran))?.id).toBe(first);
    expect((await planOf(ran))?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(await planOf(neverRan)).toEqual({ id: null, at: null });
    expect(await planOf(planGone)).toEqual({ id: null, at: null });
    expect(await planOf(seeded)).toEqual({ id: null, at: null });

    // `/resolve` applies the same rule to a Thread the backfill missed.
    // The backfilled Thread is refused with the first plan's limit.
    const held = await resolve(ran, `${ran}-1`);
    expect(held.status).toBe(400);
    expect(
      parseClaudePlanLimit((held.body as { message: string }).message),
    ).toBeDefined();
    // The Thread whose latest turn ran on the first plan is refused with
    // that plan's limit and bound to it, never moved to the second.
    await turn(seeded, first, "2026-10-30T12:00:00.000Z");
    const resolved = await resolve(seeded, `${seeded}-2`);
    expect(resolved.status).toBe(400);
    expect(
      parseClaudePlanLimit((resolved.body as { message: string }).message),
    ).toBeDefined();
    expect((await planOf(seeded))?.id).toBe(first);
    // A Thread whose plan was deleted before any binding is refused too.
    const gone = await resolve(planGone, `${planGone}-1`);
    expect(gone.status).toBe(400);
    expect(gone.body).toEqual({
      code: "CLAUDE_PLAN_UNAVAILABLE",
      class: "account",
      message: expect.stringContaining("was removed"),
    });
    expect(await planOf(planGone)).toEqual({ id: null, at: null });
    // A Thread that never ran takes the open second plan.
    expect((await resolve(neverRan, `${neverRan}-1`)).status).toBe(200);
    expect((await planOf(neverRan))?.id).toBe(second);
  });

  it("gives no extra usage choice to an account that has none", async () => {
    const { cookie, userId } = await signup(
      "claude-plan-no-extra@example.com",
      174,
    );
    expect(
      (
        await call(`${base}/connections`, cookie, "POST", {
          name: "Claude Pro/Max",
          kind: "provider",
          providerId: "claude-code",
          apiKey: TOKEN,
        })
      ).status,
    ).toBe(200);
    const { id } = await claudeConnection(cookie);
    // The owner chose extra usage, but the account's organization turned it
    // off, as Anthropic answered for a real Team plan.
    expect(
      (
        await call(`${base}/connections/${id}/claude-plan`, cookie, "POST", {
          allowExtraUsage: true,
        })
      ).status,
    ).toBe(200);
    const threadId = "claude-plan-no-extra-thread";
    await seedThread(userId, threadId);
    const submissionId = `${threadId}-1`;
    expect(
      (
        await post(threadId, "/resolve", {
          threadId,
          submissionId,
          recovery: false,
        })
      ).status,
    ).toBe(200);
    const reset = now() + 3 * hour;
    expect(
      (
        await post(threadId, "/claude-code-usage", {
          threadId,
          submissionId,
          canonical: MODEL,
          reading: {
            status: "rejected",
            limit: { id: "five_hour", resetsAt: reset },
            windows: [{ id: "five_hour", utilization: 1, resetsAt: reset }],
            extraUsage: {
              status: "rejected",
              inUse: false,
              disabledReason: "org_level_disabled",
            },
          },
          observedAt: now(),
        })
      ).status,
    ).toBe(200);
    expect((await claudeConnection(cookie)).claudePlan).toMatchObject({
      allowExtraUsage: true,
      usage: { extraUsage: { disabledReason: "org_level_disabled" } },
    });

    // dx holds new work without telling the owner to allow extra usage.
    const refused = await post(threadId, "/resolve", {
      threadId,
      submissionId: `${threadId}-2`,
      recovery: false,
    });
    expect(refused.status).toBe(400);
    expect(
      parseClaudePlanLimit((refused.body as { message: string }).message),
    ).toEqual({
      window: "five_hour",
      resetsAt: Math.floor(reset / 60) * 60,
      cause: "exhausted",
    });
  });
});
