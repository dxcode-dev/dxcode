import { env } from "cloudflare:test";
import {
  afterEach,
  assert,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import app from "../../src/app.js";
import { startThread } from "../../src/automations/wake.js";
import type { Bindings } from "../../src/http/types.js";
import {
  TEST_CONFIG_ENCRYPTION_KEYS,
  TEST_RUNNER_PROFILE_CATALOG,
} from "../../src/testing/bindings.js";
import { createThreadTools } from "../../src/threads/agent-tools.js";

/**
 * A person or an agent picks the Claude Pro/Max plan a new Claude Code
 * Thread runs on, from each plan's last-known limits, which only Claude Code
 * runs report. The Thread is bound to the plan when it is created and never
 * takes another. Core makes no Anthropic call beyond the model list check
 * when a plan is saved. Every token here is a dummy.
 */

const origin = "http://dx.test";
const password = "claude-plan-pick-password-1234";
const bindings: Bindings = {
  DB: env.DB,
  AI: { run: async () => ({}) } as unknown as Ai,
  DX_ENV: "local",
  DX_AUTH_URL: origin,
  DX_AUTH_TRUSTED_ORIGINS: origin,
  DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
  DX_SIGNUP_ENABLED: "true",
  DX_RUNNER_PROFILE_CATALOG: TEST_RUNNER_PROFILE_CATALOG,
  BETTER_AUTH_SECRET: "claude-plan-pick-secret-0000000000000000",
  BYOK_CREDENTIAL_COORDINATOR: env.BYOK_CREDENTIAL_COORDINATOR,
};

const TOKENS = ["a", "b", "c"].map(
  (letter) => `sk-ant-oat01-${letter.repeat(48)}`,
);
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
    if (request.url === "https://api.anthropic.com/v1/models?limit=1")
      return Response.json({ data: [{ id: "claude-haiku-5-5" }] });
    anthropicCalls.push(request.url);
    return Response.json({ type: "error" }, { status: 500 });
  });
});

/**
 * Work a created Thread starts in the background, such as its first message's
 * dispatch, awaited after each test so none outlives the file.
 */
const pending: Promise<unknown>[] = [];
const keep = (promise: Promise<unknown>) => {
  pending.push(promise);
};

afterEach(async () => {
  await Promise.allSettled(pending.splice(0));
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
      body: JSON.stringify({ name: "Plan Picker", email, password }),
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

const connect = async (cookie: string, name: string, apiKey: string) => {
  const response = await call(`${base}/connections`, cookie, "POST", {
    name,
    kind: "provider",
    providerId: "claude-code",
    apiKey,
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { data: { id: string } }).data.id;
};

/** What Claude Code reported for a plan, as the coordinator stores it. */
const reported = async (
  connectionId: string,
  windows: { id: string; utilization: number; resetsAt: number }[],
  limit?: { id: string; resetsAt: number },
) => {
  const usage = {
    status: limit === undefined ? "allowed" : "rejected",
    ...(limit === undefined ? {} : { limit }),
    windows,
    extraUsage: { status: "rejected", inUse: false },
    observedAt: now() - 60,
  };
  await env.DB.prepare(
    `INSERT INTO claude_code_plan (connection_id, usage, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT (connection_id) DO UPDATE SET usage = excluded.usage`,
  )
    .bind(connectionId, JSON.stringify(usage), new Date().toISOString())
    .run();
  return usage;
};

const seedProject = async (userId: string, projectId: string) => {
  const at = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO projects (id, owner_user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(projectId, userId, `Plans ${projectId}`, at, at)
    .run();
};

const selection = { kind: "model", model: MODEL, thinking: "high" };

const create = async (
  cookie: string,
  projectId: string,
  extra: Record<string, unknown>,
) => {
  const response = await call("/v1/threads", cookie, "POST", {
    projectId,
    title: "Plan pick",
    ...extra,
  });
  return {
    status: response.status,
    body: (await response.json()) as {
      data: { id?: string; code?: string; message?: string; resetsAt?: string };
    },
  };
};

const boundTo = async (threadId: string) =>
  env.DB.prepare(
    "SELECT claude_connection_id, claude_connection_bound_at FROM threads WHERE id = ?",
  )
    .bind(threadId)
    .first<{
      claude_connection_id: string | null;
      claude_connection_bound_at: string | null;
    }>();

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

/** The token Claude Code would get for the Thread's next submission. */
const tokenOf = async (threadId: string, submissionId: string) => {
  const resolved = await post(threadId, "/resolve", {
    threadId,
    submissionId,
    recovery: false,
  });
  expect(resolved.status).toBe(200);
  const credential = await post(threadId, "/claude-code-credential", {
    threadId,
    submissionId,
    canonical: MODEL,
  });
  return (credential.body as { token: string }).token;
};

describe("Claude plan pick", () => {
  it("lists each plan's last-known limits for the composer and list_agent_modes", async () => {
    const { cookie } = await signup("claude-plan-pick-limits@example.com", 181);
    const first = await connect(cookie, "Claude Pro/Max", TOKENS[0]);
    const second = await connect(cookie, "Claude Pro/Max 2", TOKENS[1]);
    const third = await connect(cookie, "Claude Pro/Max 3", TOKENS[2]);
    const reset = now() + 2 * hour;
    const weekly = now() + 50 * hour;
    const firstUsage = await reported(
      first,
      [
        { id: "five_hour", utilization: 1, resetsAt: reset },
        { id: "seven_day", utilization: 0.4, resetsAt: weekly },
      ],
      { id: "five_hour", resetsAt: reset },
    );
    const secondUsage = await reported(second, [
      { id: "five_hour", utilization: 0.25, resetsAt: reset },
    ]);
    const disabled = await call(
      `${base}/connections/${third}/enabled`,
      cookie,
      "POST",
      { enabled: false },
    );
    expect(disabled.status).toBe(200);

    const choices = (await (await call(`${base}/choices`, cookie)).json()) as {
      data: { claudePlans: unknown };
    };
    // In routing order, each with its running Threads; the third never ran
    // Claude Code, so its limits are unknown.
    expect(choices.data.claudePlans).toEqual([
      {
        connectionId: first,
        name: "Claude Pro/Max",
        enabled: true,
        allowExtraUsage: false,
        usage: firstUsage,
        load: 0,
      },
      {
        connectionId: second,
        name: "Claude Pro/Max 2",
        enabled: true,
        allowExtraUsage: false,
        usage: secondUsage,
        load: 0,
      },
      {
        connectionId: third,
        name: "Claude Pro/Max 3",
        enabled: false,
        allowExtraUsage: false,
        load: 0,
      },
    ]);
  });

  it("binds a new Thread to the plan picked at creation, dx's pick when none is named, and refuses a used-up, disabled, or foreign plan", async () => {
    const { cookie, userId } = await signup(
      "claude-plan-pick-create@example.com",
      182,
    );
    const first = await connect(cookie, "Claude Pro/Max", TOKENS[0]);
    const second = await connect(cookie, "Claude Pro/Max 2", TOKENS[1]);
    const projectId = "prj_00000000-0000-4000-8000-0000000c1a01";
    await seedProject(userId, projectId);

    // Two plans and no pick: dx picks one of them.
    const unpicked = await create(cookie, projectId, { selection });
    expect(unpicked.status).toBe(201);
    assert.exists(unpicked.body.data.id);
    expect([first, second]).toContain(
      (await boundTo(unpicked.body.data.id))?.claude_connection_id,
    );

    // The second plan, picked, though the first is first in order.
    const picked = await create(cookie, projectId, {
      selection,
      claudeConnectionId: second,
    });
    expect(picked.status).toBe(201);
    const threadId = picked.body.data.id;
    assert.exists(threadId);
    expect(await boundTo(threadId)).toMatchObject({
      claude_connection_id: second,
      claude_connection_bound_at: expect.any(String),
    });
    expect(await tokenOf(threadId, `${threadId}-1`)).toBe(TOKENS[1]);

    // The picked plan used up: the Thread waits for it, never moving.
    const reset = now() + 3 * hour;
    await reported(
      second,
      [{ id: "five_hour", utilization: 1, resetsAt: reset }],
      { id: "five_hour", resetsAt: reset },
    );
    const waiting = await post(threadId, "/resolve", {
      threadId,
      submissionId: `${threadId}-2`,
      recovery: false,
    });
    expect(waiting.status).toBe(400);
    expect((await boundTo(threadId))?.claude_connection_id).toBe(second);

    // A new Thread on the used-up plan is refused with its reset time.
    const usedUp = await create(cookie, projectId, {
      selection,
      claudeConnectionId: second,
    });
    expect(usedUp.status).toBe(409);
    expect(usedUp.body.data).toMatchObject({
      code: "CLAUDE_PLAN_USED_UP",
      resetsAt: new Date(reset * 1000).toISOString(),
    });
    expect(usedUp.body.data.message).toContain("Claude Pro/Max 2");

    // A disabled plan, another person's plan, and a plan for a Thread that
    // does not run Claude Code are refused.
    expect(
      (
        await call(`${base}/connections/${first}/enabled`, cookie, "POST", {
          enabled: false,
        })
      ).status,
    ).toBe(200);
    const off = await create(cookie, projectId, {
      selection,
      claudeConnectionId: first,
    });
    expect(off.status).toBe(400);
    expect(off.body.data.code).toBe("CLAUDE_PLAN_UNAVAILABLE");
    const other = await signup("claude-plan-pick-other@example.com", 183);
    const foreign = await connect(other.cookie, "Claude Pro/Max", TOKENS[2]);
    const notMine = await create(cookie, projectId, {
      selection,
      claudeConnectionId: foreign,
    });
    expect(notMine.status).toBe(400);
    expect(notMine.body.data.code).toBe("CLAUDE_PLAN_UNAVAILABLE");
    const notClaude = await create(cookie, projectId, {
      selection: { kind: "mode", profileId: "default", mode: "medium" },
      claudeConnectionId: second,
    });
    expect(notClaude.status).toBe(400);
    expect(notClaude.body.data.code).toBe("CLAUDE_PLAN_UNAVAILABLE");

    // With one enabled plan left, a Thread needs no pick, as before.
    expect(
      (
        await call(`${base}/connections/${first}/enabled`, cookie, "POST", {
          enabled: true,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call(`${base}/connections/${second}/enabled`, cookie, "POST", {
          enabled: false,
        })
      ).status,
    ).toBe(200);
    const single = await create(cookie, projectId, { selection });
    expect(single.status).toBe(201);
  });
});

/**
 * The automatic pick (#1685): with no plan named, dx binds a new Claude Code
 * Thread to a plan by each plan's 5-hour and weekly readings and its running
 * Threads, once, at creation. The policy is on the issue. It is on for
 * everyone.
 */
describe("Claude plan auto pick", () => {
  const day = 24 * hour;

  /** A Thread no longer counts toward its plan's load. */
  const settle = (threadId: string) =>
    env.DB.prepare(
      `UPDATE threads SET activity_status = 'idle',
         claude_connection_bound_at = '2026-01-01T00:00:00.000Z' WHERE id = ?`,
    )
      .bind(threadId)
      .run();

  const working = (threadId: string) =>
    env.DB.prepare(
      "UPDATE threads SET activity_status = 'working' WHERE id = ?",
    )
      .bind(threadId)
      .run();

  const plansOf = async (cookie: string) =>
    (
      (await (await call(`${base}/choices`, cookie)).json()) as {
        data: { claudePlans: { connectionId: string; load?: number }[] };
      }
    ).data.claudePlans;

  /** Three plans: nearly full, mid-window resetting soon, never used. */
  const threePlans = async (email: string, index: number, project: string) => {
    const { cookie, userId } = await signup(email, index);
    const nearlyFull = await connect(cookie, "Claude Pro/Max", TOKENS[0]);
    const resetsSoon = await connect(cookie, "Claude Pro/Max 2", TOKENS[1]);
    const unused = await connect(cookie, "Claude Pro/Max 3", TOKENS[2]);
    await reported(nearlyFull, [
      { id: "five_hour", utilization: 0.92, resetsAt: now() + 4 * hour },
      { id: "seven_day", utilization: 0.2, resetsAt: now() + 4 * day },
    ]);
    await reported(resetsSoon, [
      { id: "five_hour", utilization: 0.5, resetsAt: now() + hour },
      { id: "seven_day", utilization: 0.3, resetsAt: now() + 4 * day },
    ]);
    await seedProject(userId, project);
    // A child starts with a message, so its project needs an Orb size.
    await env.DB.prepare(
      "UPDATE projects SET runner_profile_id = 'a1.medium' WHERE id = ?",
    )
      .bind(project)
      .run();
    return { cookie, userId, nearlyFull, resetsSoon, unused };
  };

  it("binds a new Thread to the plan the readings call for, and never moves it", async () => {
    const projectId = "prj_00000000-0000-4000-8000-0000000c1685";
    const { cookie, nearlyFull, resetsSoon, unused } = await threePlans(
      "claude-plan-auto-pick@example.com",
      184,
      projectId,
    );

    // The window that resets in an hour, half used, goes first: the plan
    // first in routing order would run out before its reset.
    const first = await create(cookie, projectId, { selection });
    expect(first.status).toBe(201);
    const firstId = first.body.data.id;
    assert.exists(firstId);
    expect(await boundTo(firstId)).toMatchObject({
      claude_connection_id: resetsSoon,
      claude_connection_bound_at: expect.any(String),
    });
    expect(await tokenOf(firstId, `${firstId}-1`)).toBe(TOKENS[1]);
    expect(
      (await plansOf(cookie)).map(({ connectionId, load }) => [
        connectionId,
        load,
      ]),
    ).toEqual([
      [nearlyFull, 0],
      [resetsSoon, 1],
      [unused, 0],
    ]);

    // Ahead of its weekly pace (80% with four days to go): the unused plan.
    await reported(resetsSoon, [
      { id: "five_hour", utilization: 0.5, resetsAt: now() + hour },
      { id: "seven_day", utilization: 0.8, resetsAt: now() + 4 * day },
    ]);
    const behindPace = await create(cookie, projectId, { selection });
    assert.exists(behindPace.body.data.id);
    expect((await boundTo(behindPace.body.data.id))?.claude_connection_id).toBe(
      unused,
    );
    await settle(behindPace.body.data.id);

    // Back on pace, but six Threads already run on it: the unused plan.
    // A named plan wins over the pick, even one it would skip.
    await reported(resetsSoon, [
      { id: "five_hour", utilization: 0.5, resetsAt: now() + hour },
      { id: "seven_day", utilization: 0.3, resetsAt: now() + 4 * day },
    ]);
    for (let index = 0; index < 5; index += 1) {
      const named = await create(cookie, projectId, {
        selection,
        claudeConnectionId: resetsSoon,
      });
      assert.exists(named.body.data.id);
      await working(named.body.data.id);
    }
    const loaded = await create(cookie, projectId, { selection });
    assert.exists(loaded.body.data.id);
    expect((await boundTo(loaded.body.data.id))?.claude_connection_id).toBe(
      unused,
    );
    const named = await create(cookie, projectId, {
      selection,
      claudeConnectionId: nearlyFull,
    });
    assert.exists(named.body.data.id);
    expect((await boundTo(named.body.data.id))?.claude_connection_id).toBe(
      nearlyFull,
    );

    // Its plan used up, the first Thread waits; it never takes another.
    const reset = now() + hour;
    await reported(
      resetsSoon,
      [{ id: "five_hour", utilization: 1, resetsAt: reset }],
      { id: "five_hour", resetsAt: reset },
    );
    const waiting = await post(firstId, "/resolve", {
      threadId: firstId,
      submissionId: `${firstId}-2`,
      recovery: false,
    });
    expect(waiting.status).toBe(400);
    expect((await boundTo(firstId))?.claude_connection_id).toBe(resetsSoon);

    // Every plan used up: refused, with the soonest reset.
    for (const [plan, hours] of [
      [nearlyFull, 3],
      [unused, 2],
    ] as const) {
      const at = now() + hours * hour;
      await reported(
        plan,
        [{ id: "five_hour", utilization: 1, resetsAt: at }],
        {
          id: "five_hour",
          resetsAt: at,
        },
      );
    }
    const refused = await create(cookie, projectId, { selection });
    expect(refused.status).toBe(409);
    expect(refused.body.data).toMatchObject({
      code: "CLAUDE_PLAN_USED_UP",
      resetsAt: new Date(reset * 1000).toISOString(),
    });
    expect(refused.body.data.message).toContain("Claude Pro/Max 2");
  });

  it("gives a child the pick, not its parent's plan, unless the caller names one", async () => {
    const projectId = "prj_00000000-0000-4000-8000-0000000c1686";
    const { cookie, userId, nearlyFull, resetsSoon, unused } = await threePlans(
      "claude-plan-auto-child@example.com",
      185,
      projectId,
    );
    const parent = await create(cookie, projectId, {
      selection,
      claudeConnectionId: nearlyFull,
    });
    const parentId = parent.body.data.id;
    assert.exists(parentId);
    await settle(parentId);

    const tools = Object.fromEntries(
      createThreadTools(
        parentId,
        () => ({ db: env.DB, bindings, waitUntil: keep }),
        "sub_auto_child",
      ).map((tool) => [
        tool.name,
        tool as unknown as {
          run: (input: {
            data: Record<string, unknown>;
            toolCallId: string;
          }) => Promise<{ output: Record<string, unknown> }>;
        },
      ]),
    );
    const listed = await tools.list_agent_modes?.run({
      data: {},
      toolCallId: "modes",
    });
    expect(listed?.output.claudeAutoPlan).toMatchObject({
      plan: resetsSoon,
      name: "Claude Pro/Max 2",
      why: expect.stringMatching(
        /^Resets soonest with room left: 5-hour limit 50%/,
      ),
    });

    const childOf = async (data: Record<string, unknown>, call: string) => {
      const created = await tools.create_thread?.run({
        data: {
          prompt: "Child work.",
          title: "Child",
          agent_mode: MODEL,
          ...data,
        },
        toolCallId: call,
      });
      const threadId = created?.output.threadId as string;
      await settle(threadId);
      return (await boundTo(threadId))?.claude_connection_id;
    };
    expect(await childOf({}, "auto-child")).toBe(resetsSoon);
    expect(await childOf({ claude_plan: unused }, "named-child")).toBe(unused);

    // An automation's Thread takes the pick too.
    const automated = await startThread(
      {
        bindings,
        ownerUserId: userId,
        automation: "schedule",
        waitUntil: keep,
      },
      {
        parentThreadId: parentId,
        projectId,
        title: "Scheduled",
        prompt: "Scheduled work.",
        selection: { kind: "model", model: MODEL, thinking: "high" },
        key: "claude-plan-auto-schedule",
      },
    );
    expect((await boundTo(automated))?.claude_connection_id).toBe(resetsSoon);
  });

  it("picks only among the creating person's own plans, though another person's has more room", async () => {
    const projectId = "prj_00000000-0000-4000-8000-0000000c1687";
    const a = await signup("claude-plan-auto-owner-a@example.com", 186);
    const b = await signup("claude-plan-auto-owner-b@example.com", 187);
    // A's plans are both near their 5-hour limit; B's plan is unused, with
    // none of its Threads running, so it has the most room of all.
    const aFirst = await connect(a.cookie, "Claude Pro/Max", TOKENS[0]);
    const aSecond = await connect(a.cookie, "Claude Pro/Max 2", TOKENS[1]);
    const bPlan = await connect(b.cookie, "Claude Pro/Max", TOKENS[2]);
    await reported(aFirst, [
      { id: "five_hour", utilization: 0.97, resetsAt: now() + 4 * hour },
    ]);
    await reported(aSecond, [
      { id: "five_hour", utilization: 0.95, resetsAt: now() + 4 * hour },
    ]);
    await seedProject(a.userId, projectId);
    await env.DB.prepare(
      "UPDATE projects SET runner_profile_id = 'a1.medium' WHERE id = ?",
    )
      .bind(projectId)
      .run();

    // A's routing choices and list_agent_modes know only A's plans.
    expect(
      (await plansOf(a.cookie)).map(({ connectionId }) => connectionId),
    ).toEqual([aFirst, aSecond]);

    // From the composer: A's plan with the most room, never B's.
    const composer = await create(a.cookie, projectId, { selection });
    expect(composer.status).toBe(201);
    const composerId = composer.body.data.id;
    assert.exists(composerId);
    expect((await boundTo(composerId))?.claude_connection_id).toBe(aSecond);
    expect(await tokenOf(composerId, `${composerId}-1`)).toBe(TOKENS[1]);
    await settle(composerId);

    // From an automation: the same, never B's.
    const automated = await startThread(
      {
        bindings,
        ownerUserId: a.userId,
        automation: "schedule",
        waitUntil: keep,
      },
      {
        parentThreadId: composerId,
        projectId,
        title: "Scheduled",
        prompt: "Scheduled work.",
        selection: { kind: "model", model: MODEL, thinking: "high" },
        key: "claude-plan-auto-two-owners",
      },
    );
    const automatedPlan = (await boundTo(automated))?.claude_connection_id;
    expect([aFirst, aSecond]).toContain(automatedPlan);
    expect(automatedPlan).not.toBe(bPlan);

    // A's plans used up: refused, never moved to B's open plan.
    for (const plan of [aFirst, aSecond]) {
      const at = now() + 2 * hour;
      await reported(
        plan,
        [{ id: "five_hour", utilization: 1, resetsAt: at }],
        {
          id: "five_hour",
          resetsAt: at,
        },
      );
    }
    const refused = await create(a.cookie, projectId, { selection });
    expect(refused.status).toBe(409);
    expect(refused.body.data.code).toBe("CLAUDE_PLAN_USED_UP");
    await expect(
      startThread(
        {
          bindings,
          ownerUserId: a.userId,
          automation: "schedule",
          waitUntil: keep,
        },
        {
          parentThreadId: composerId,
          projectId,
          title: "Scheduled",
          prompt: "Scheduled work.",
          selection: { kind: "model", model: MODEL, thinking: "high" },
          key: "claude-plan-auto-two-owners-used-up",
        },
      ),
    ).rejects.toThrow(/409|CLAUDE_PLAN_USED_UP/);
    const onB = await env.DB.prepare(
      "SELECT COUNT(*) AS bound FROM threads WHERE claude_connection_id = ?",
    )
      .bind(bPlan)
      .first<{ bound: number }>();
    expect(onB?.bound).toBe(0);
  });

  it("picks for every owner without a setting: the composer, the choices, and an agent's child", async () => {
    const projectId = "prj_00000000-0000-4000-8000-0000000c1688";
    const { cookie, nearlyFull, resetsSoon, unused } = await threePlans(
      "claude-plan-auto-default@example.com",
      188,
      projectId,
    );

    // The composer: no pick takes dx's, and the choices carry each plan's
    // running Threads, with no switch for the pick.
    const unpicked = await create(cookie, projectId, { selection });
    expect(unpicked.status).toBe(201);
    const unpickedId = unpicked.body.data.id;
    assert.exists(unpickedId);
    expect((await boundTo(unpickedId))?.claude_connection_id).toBe(resetsSoon);
    await settle(unpickedId);
    const choices = (
      (await (await call(`${base}/choices`, cookie)).json()) as {
        data: Record<string, unknown> & {
          claudePlans: Record<string, unknown>[];
        };
      }
    ).data;
    expect(choices).not.toHaveProperty("claudeAutoPick");
    expect(
      choices.claudePlans.map(({ connectionId, load }) => [connectionId, load]),
    ).toEqual([
      [nearlyFull, 0],
      [resetsSoon, 0],
      [unused, 0],
    ]);

    const parent = await create(cookie, projectId, {
      selection,
      claudeConnectionId: nearlyFull,
    });
    const parentId = parent.body.data.id;
    assert.exists(parentId);
    await settle(parentId);

    // An agent: create_thread with no plan takes the pick, not the parent's.
    const tools = Object.fromEntries(
      createThreadTools(
        parentId,
        () => ({ db: env.DB, bindings, waitUntil: keep }),
        "sub_auto_default",
      ).map((tool) => [
        tool.name,
        tool as unknown as {
          run: (input: {
            data: Record<string, unknown>;
            toolCallId: string;
          }) => Promise<{ output: Record<string, unknown> }>;
        },
      ]),
    );
    const listed = await tools.list_agent_modes?.run({
      data: {},
      toolCallId: "modes-default",
    });
    expect(listed?.output.claudeAutoPlan).toMatchObject({ plan: resetsSoon });
    const child = await tools.create_thread?.run({
      data: { prompt: "Child work.", title: "Child", agent_mode: MODEL },
      toolCallId: "default-child",
    });
    const childId = child?.output.threadId as string;
    expect((await boundTo(childId))?.claude_connection_id).toBe(resetsSoon);
  });
});

describe("A new Space's Claude plan", () => {
  // Ways it could go wrong: the picked plan is ignored and the Space takes
  // the first (or Auto's) plan; a plan that is used up, disabled, or not the
  // person's is bound anyway, or moves the Space to another plan; a refused
  // plan still leaves a Space behind.
  const space = async (
    cookie: string,
    projectId: string,
    claudeConnectionId?: string,
  ) => {
    const response = await call("/v1/spaces", cookie, "POST", {
      projectId,
      name: "Plans Space",
      sharing: "private",
      ...(claudeConnectionId === undefined ? {} : { claudeConnectionId }),
    });
    return {
      status: response.status,
      body: (await response.json()) as {
        data: {
          space?: { threadId: string };
          code?: string;
          message?: string;
        };
      },
    };
  };
  const spaces = async (userId: string) =>
    (
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM space JOIN threads ON threads.id = space.thread_id WHERE threads.owner_user_id = ?",
      )
        .bind(userId)
        .first<{ count: number }>()
    )?.count;

  it("binds the Space's Thread to the plan picked in Create Space", async () => {
    const { cookie, userId } = await signup(
      "claude-plan-pick-space@example.com",
      191,
    );
    // Auto's Space model (Opus), which Claude Code serves.
    await env.DB.prepare("DELETE FROM space_agent_model WHERE user_id = ?")
      .bind(userId)
      .run();
    const first = await connect(cookie, "Claude Pro/Max", TOKENS[0]);
    const second = await connect(cookie, "Claude Pro/Max 2", TOKENS[1]);
    const third = await connect(cookie, "Claude Pro/Max 3", TOKENS[2]);
    await seedProject(userId, "prj_00000000-0000-4000-8000-0000000b1a51");
    const projectId = "prj_00000000-0000-4000-8000-0000000b1a51";

    const picked = await space(cookie, projectId, third);
    expect(picked.status).toBe(201);
    const threadId = picked.body.data.space?.threadId as string;
    expect((await boundTo(threadId))?.claude_connection_id).toBe(third);

    // Unpicked, a Space takes the first plan, as before.
    const unpicked = await space(cookie, projectId);
    expect(unpicked.status).toBe(201);
    expect(
      (await boundTo(unpicked.body.data.space?.threadId as string))
        ?.claude_connection_id,
    ).toBe(first);

    // A used-up plan says why and leaves no Space; it never moves the Space
    // to another plan.
    const reset = now() + 2 * hour;
    await reported(
      second,
      [{ id: "five_hour", utilization: 1, resetsAt: reset }],
      { id: "five_hour", resetsAt: reset },
    );
    const before = await spaces(userId);
    const usedUp = await space(cookie, projectId, second);
    expect(usedUp.status).toBe(409);
    expect(usedUp.body.data.code).toBe("SPACE_PLAN_UNAVAILABLE");
    expect(usedUp.body.data.message).toContain("Claude Pro/Max 2 is used up");
    const notMine = await space(
      cookie,
      projectId,
      "mcon_00000000-0000-4000-8000-000000000000",
    );
    expect(notMine.status).toBe(409);
    expect(notMine.body.data.code).toBe("SPACE_PLAN_UNAVAILABLE");
    expect(await spaces(userId)).toBe(before);
  });
});
