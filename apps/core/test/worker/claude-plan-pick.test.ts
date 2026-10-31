import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../src/app.js";
import type { Bindings } from "../../src/http/types.js";
import {
  TEST_CONFIG_ENCRYPTION_KEYS,
  TEST_RUNNER_PROFILE_CATALOG,
} from "../../src/testing/bindings.js";

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
    const first = await connect(cookie, "Claude Pro/Max", TOKENS[0]!);
    const second = await connect(cookie, "Claude Pro/Max 2", TOKENS[1]!);
    const third = await connect(cookie, "Claude Pro/Max 3", TOKENS[2]!);
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
    // In routing order; the third never ran Claude Code, so its limits are
    // unknown.
    expect(choices.data.claudePlans).toEqual([
      {
        connectionId: first,
        name: "Claude Pro/Max",
        enabled: true,
        allowExtraUsage: false,
        usage: firstUsage,
      },
      {
        connectionId: second,
        name: "Claude Pro/Max 2",
        enabled: true,
        allowExtraUsage: false,
        usage: secondUsage,
      },
      {
        connectionId: third,
        name: "Claude Pro/Max 3",
        enabled: false,
        allowExtraUsage: false,
      },
    ]);
  });

  it("binds a new Thread to the plan picked at creation, and refuses a used-up, disabled, or foreign plan", async () => {
    const { cookie, userId } = await signup(
      "claude-plan-pick-create@example.com",
      182,
    );
    const first = await connect(cookie, "Claude Pro/Max", TOKENS[0]!);
    const second = await connect(cookie, "Claude Pro/Max 2", TOKENS[1]!);
    const projectId = "prj_00000000-0000-4000-8000-0000000c1a01";
    await seedProject(userId, projectId);

    // Two plans and no pick: the person or agent must choose one.
    const unpicked = await create(cookie, projectId, { selection });
    expect(unpicked.status).toBe(400);
    expect(unpicked.body.data.code).toBe("CLAUDE_PLAN_REQUIRED");
    expect(unpicked.body.data.message).toContain(first);
    expect(unpicked.body.data.message).toContain(second);

    // The second plan, picked, though the first is first in order.
    const picked = await create(cookie, projectId, {
      selection,
      claudeConnectionId: second,
    });
    expect(picked.status).toBe(201);
    const threadId = picked.body.data.id!;
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
    const foreign = await connect(other.cookie, "Claude Pro/Max", TOKENS[2]!);
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
