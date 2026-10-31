import { env } from "cloudflare:test";
import { parseClaudePlanLimit } from "@dx/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../src/app.js";
import type { Bindings } from "../../src/http/types.js";
import { TEST_CONFIG_ENCRYPTION_KEYS } from "../../src/testing/bindings.js";

/**
 * Core sends a Claude Pro/Max token to Anthropic only to ask the model list
 * whether it is valid when it is saved. Everything else that uses the plan,
 * including its limits, is the Claude Code binary's in an Orb.
 *
 * Every outbound request from the Worker and its Durable Objects is
 * recorded. A request to Anthropic gets the answer it would get for a live
 * token, so code that calls Anthropic goes on as it would in production and
 * the recording shows the call.
 */

const origin = "http://dx.test";
const password = "claude-code-password-1234";
const bindings: Bindings = {
  DB: env.DB,
  DX_ENV: "local",
  DX_AUTH_URL: origin,
  DX_AUTH_TRUSTED_ORIGINS: origin,
  DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
  DX_SIGNUP_ENABLED: "true",
  BETTER_AUTH_SECRET: "claude-code-connection-secret-0000000",
  BYOK_CREDENTIAL_COORDINATOR: env.BYOK_CREDENTIAL_COORDINATOR,
};

// Fake tokens of the real shape; no real Claude token is ever used.
const TOKEN = `sk-ant-oat01-${"v".repeat(48)}`;
const NEW_TOKEN = `sk-ant-oat01-${"n".repeat(48)}`;
const FORGED = `sk-ant-oat01-${"f".repeat(48)}`;
const MODEL_LIST = "https://api.anthropic.com/v1/models?limit=1";
const MODEL = "claude-code/claude-opus-5-5";
const hour = 3_600;
const now = () => Math.floor(Date.now() / 1000);

interface Outbound {
  readonly url: string;
  readonly headers: string;
  readonly body: string;
}
const outbound: Outbound[] = [];
const anthropic = () =>
  outbound.filter(({ url }) => new URL(url).hostname.endsWith("anthropic.com"));
/** Each Anthropic request: its URL, the plan token it carried, its body. */
const anthropicCalls = () =>
  anthropic().map(({ url, headers, body }) => ({
    url,
    token:
      [TOKEN, NEW_TOKEN, FORGED].find((token) => headers.includes(token)) ??
      "none",
    body,
  }));
const modelCheck = (token: string) => ({ url: MODEL_LIST, token, body: "" });
/** Requests carrying a plan token anywhere but the model list check. */
const carryingTokenElsewhere = () =>
  outbound.filter(
    ({ url, headers, body }) =>
      url !== MODEL_LIST &&
      [TOKEN, NEW_TOKEN, FORGED].some(
        (token) => headers.includes(token) || body.includes(token),
      ),
  );

beforeEach(() => {
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    outbound.push({
      url: request.url,
      headers: JSON.stringify([...request.headers]),
      body: await request.clone().text(),
    });
    if (!new URL(request.url).hostname.endsWith("anthropic.com"))
      return real(input, init);
    const authorization = request.headers.get("authorization");
    if (
      authorization !== `Bearer ${TOKEN}` &&
      authorization !== `Bearer ${NEW_TOKEN}`
    )
      return Response.json(
        { type: "error", error: { type: "authentication_error" } },
        { status: 401 },
      );
    return request.url.includes("/v1/models")
      ? Response.json({ data: [{ id: "claude-haiku-5-5" }] })
      : Response.json(
          {
            content: [{ type: "text", text: "ok" }],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
          {
            headers: {
              "anthropic-ratelimit-unified-status": "allowed",
              "anthropic-ratelimit-unified-5h-utilization": "0.1",
              "anthropic-ratelimit-unified-5h-reset": String(now() + hour),
            },
          },
        );
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  outbound.length = 0;
});

let signupIndex = 120;
const signup = async (email: string) => {
  signupIndex += 1;
  const response = await app.request(
    "/api/auth/sign-up/email",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        "cf-connecting-ip": `198.51.100.${signupIndex}`,
      },
      body: JSON.stringify({ name: "Claude Owner", email, password }),
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
const connect = (cookie: string, apiKey: string, name = "Claude Pro/Max") =>
  call(`${base}/connections`, cookie, "POST", {
    name,
    kind: "provider",
    providerId: "claude-code",
    apiKey,
  });

interface ConnectionBody {
  id: string;
  providerId: string;
  health: { state: string; code: string };
  credential?: { present: boolean };
  claudePlan?: { allowExtraUsage: boolean; usage?: unknown };
}

const checkAccess = async (cookie: string, id: string) => {
  const response = await call(
    `${base}/connections/${id}/check-access`,
    cookie,
    "POST",
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { data: ConnectionBody }).data;
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

const seedThread = async (userId: string, threadId: string) => {
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
      JSON.stringify({ kind: "model", model: MODEL, thinking: "high" }),
      at,
      at,
    ),
  ]);
};

describe("Claude Pro/Max connection", () => {
  it("checks a plan token on Anthropic's model list when it is saved, and sends it nowhere else", async () => {
    const { cookie, userId } = await signup("claude-code-connect@example.com");

    const malformed = await connect(cookie, "not-a-claude-token");
    expect(malformed.status).toBe(400);
    expect(JSON.stringify(await malformed.json())).toContain(
      "claude setup-token",
    );

    // A token Anthropic's model list rejects is never stored.
    const forged = await connect(cookie, FORGED);
    expect(forged.status).toBe(400);
    expect(JSON.stringify(await forged.json())).toContain(
      "Anthropic rejected this token",
    );
    expect(anthropicCalls()).toEqual([modelCheck(FORGED)]);

    // Saving asks the model list about the trimmed token, and nothing else.
    const connected = await connect(cookie, `  ${TOKEN}\n`);
    expect(anthropicCalls()).toEqual([modelCheck(FORGED), modelCheck(TOKEN)]);
    expect(connected.status).toBe(200);
    const body = await connected.text();
    expect(body).not.toContain(TOKEN);
    const connection = (JSON.parse(body) as { data: ConnectionBody }).data;
    expect(connection).toMatchObject({
      providerId: "claude-code",
      health: { state: "healthy", code: "CONNECTED" },
      credential: { present: true },
    });

    const choices = (await (await call(`${base}/choices`, cookie)).json()) as {
      data: { models: { canonical: string; connectionId: string }[] };
    };
    const served = choices.data.models
      .filter(({ canonical }) => canonical.startsWith("claude-code/"))
      .map(({ canonical, connectionId }) => ({ canonical, connectionId }));
    expect(served).toContainEqual({
      canonical: MODEL,
      connectionId: connection.id,
    });

    // An owner connects another plan beside the first, after it in order.
    expect((await connect(cookie, NEW_TOKEN, "Claude Pro/Max 2")).status).toBe(
      200,
    );
    const listed = (await (
      await call(`${base}/connections`, cookie)
    ).json()) as { data: { connections: ConnectionBody[] } };
    expect(
      listed.data.connections
        .filter(({ providerId }) => providerId === "claude-code")
        .map(({ health }) => health.code),
    ).toEqual(["CONNECTED", "CONNECTED"]);
    const saved = [
      modelCheck(FORGED),
      modelCheck(TOKEN),
      modelCheck(NEW_TOKEN),
    ];
    expect(anthropicCalls()).toEqual(saved);

    // Model Routing's check (run when the plan card opens and on Refresh)
    // reads nothing from Anthropic: with no run yet, the limits are unknown.
    const checked = await checkAccess(cookie, connection.id);
    expect(anthropicCalls()).toEqual(saved);
    expect(checked.health).toMatchObject({
      state: "healthy",
      code: "CONNECTED",
    });
    expect(checked.claudePlan).toEqual({ allowExtraUsage: false });

    // Unknown limits are not used-up limits: a Thread gets its plan's
    // token for Claude Code.
    const threadId = "claude-connection-thread";
    await seedThread(userId, threadId);
    const submissionId = `${threadId}-1`;
    expect(
      (
        await coordinatorPost(threadId, "/resolve", {
          threadId,
          submissionId,
          recovery: false,
        })
      ).status,
    ).toBe(200);
    const route = { threadId, submissionId, canonical: MODEL };
    expect(
      await coordinatorPost(threadId, "/claude-code-credential", route),
    ).toEqual({
      status: 200,
      body: { token: TOKEN, plan: { allowExtraUsage: false } },
    });

    // Only a limit the Claude Code binary reports holds new Threads.
    const reset = now() + 2 * hour;
    expect(
      (
        await coordinatorPost(threadId, "/claude-code-usage", {
          ...route,
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
    const refused = await coordinatorPost(threadId, "/resolve", {
      threadId,
      submissionId: `${threadId}-2`,
      recovery: false,
    });
    expect(refused.status).toBe(400);
    expect(
      parseClaudePlanLimit((refused.body as { message: string }).message),
    ).toMatchObject({ window: "five_hour" });

    // A check on a used-up plan reads nothing either; the reported limit
    // stays.
    const usedUp = await checkAccess(cookie, connection.id);
    expect(usedUp.claudePlan).toMatchObject({
      usage: { status: "rejected" },
    });
    expect(anthropicCalls()).toEqual(saved);

    // Replacing the token checks the new one the same way and drops the
    // readings, which may belong to another account.
    const replaced = await call(
      `${base}/connections/${connection.id}`,
      cookie,
      "PATCH",
      { apiKey: NEW_TOKEN },
    );
    expect(anthropicCalls()).toEqual([...saved, modelCheck(NEW_TOKEN)]);
    expect(replaced.status).toBe(200);
    expect(
      ((await replaced.json()) as { data: ConnectionBody }).data,
    ).toMatchObject({
      health: { state: "healthy", code: "CONNECTED" },
      claudePlan: { allowExtraUsage: false },
    });
    expect(
      (await checkAccess(cookie, connection.id)).claudePlan?.usage,
    ).toBeUndefined();

    // Every Anthropic request was a body-free model list check on save;
    // nothing else the Worker sent, to any host, carried a plan token.
    expect(anthropicCalls()).toEqual([...saved, modelCheck(NEW_TOKEN)]);
    expect(carryingTokenElsewhere()).toEqual([]);
  });

  it("refuses a plan token on any other connection, and never sends one saved there", async () => {
    const { cookie } = await signup("claude-code-elsewhere@example.com");
    const refusedWith = async (response: Response, field: string) => {
      expect(response.status).toBe(400);
      expect(JSON.stringify(await response.json())).toContain(field);
    };

    // As an Anthropic API key, the SDK would send it claiming to be Claude
    // Code; as a custom key or header, it would leave Core for any endpoint.
    await refusedWith(
      await call(`${base}/connections`, cookie, "POST", {
        name: "Anthropic",
        kind: "provider",
        providerId: "anthropic",
        apiKey: TOKEN,
      }),
      "Claude Pro/Max connection",
    );
    await refusedWith(
      await call(`${base}/connections`, cookie, "POST", {
        name: "Custom",
        kind: "custom",
        providerId: "dx-custom",
        baseUrl: "https://models.example.com/v1",
        format: "anthropic-messages",
        models: [{ canonical: "anthropic/claude-opus-5-5" }],
        apiKey: "sk-custom",
        headers: [{ name: "x-plan", value: TOKEN }],
      }),
      "headers.0.value",
    );
    const anthropicKey = await call(`${base}/connections`, cookie, "POST", {
      name: "Anthropic",
      kind: "provider",
      providerId: "anthropic",
      apiKey: "sk-ant-api03-not-a-plan",
    });
    expect(anthropicKey.status).toBe(200);
    const keyId = ((await anthropicKey.json()) as { data: { id: string } }).data
      .id;
    await refusedWith(
      await call(`${base}/connections/${keyId}`, cookie, "PATCH", {
        apiKey: TOKEN,
      }),
      "Claude Pro/Max connection",
    );

    expect(anthropicCalls()).toEqual([]);

    // A plan token saved on an Anthropic connection before dx refused that:
    // the access check reports it and sends nothing.
    const planConnection = await connect(cookie, TOKEN);
    expect(planConnection.status).toBe(200);
    const savedId = ((await planConnection.json()) as { data: { id: string } })
      .data.id;
    await env.DB.prepare(
      "UPDATE model_connection SET provider_id = 'anthropic' WHERE id = ?",
    )
      .bind(savedId)
      .run();
    expect((await checkAccess(cookie, savedId)).health).toMatchObject({
      state: "unhealthy",
      code: "CLAUDE_PLAN_TOKEN_ELSEWHERE",
    });

    expect(anthropicCalls()).toEqual([modelCheck(TOKEN)]);
    expect(carryingTokenElsewhere()).toEqual([]);
  });
});
