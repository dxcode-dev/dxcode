import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import app from "../../src/app.js";
import type { Bindings } from "../../src/http/types.js";
import { claudeCodeTokenFetch } from "../../src/settings/model-routing/claude-code-token.js";
import { TEST_CONFIG_ENCRYPTION_KEYS } from "../../src/testing/bindings.js";

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

const VALID = `sk-ant-oat01-${"v".repeat(48)}`;
const FORGED = `sk-ant-oat01-${"f".repeat(48)}`;
const anthropicCalls: { url: string; authorization: string | null }[] = [];

// Anthropic's model list answers 200 for a live plan token and 401 otherwise.
claudeCodeTokenFetch.current = async (input, init) => {
  const request = new Request(input, init);
  const authorization = request.headers.get("authorization");
  anthropicCalls.push({ url: request.url, authorization });
  return authorization === `Bearer ${VALID}`
    ? Response.json({ data: [{ id: "claude-haiku-5-5" }] })
    : Response.json(
        { type: "error", error: { type: "authentication_error" } },
        { status: 401 },
      );
};

afterEach(() => {
  anthropicCalls.length = 0;
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
  return cookie;
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
const connect = (cookie: string, apiKey: string) =>
  call(`${base}/connections`, cookie, "POST", {
    name: "Claude Pro/Max",
    kind: "provider",
    providerId: "claude-code",
    apiKey,
  });

describe("Claude Pro/Max connection", () => {
  it("stores only a token Anthropic accepts and never returns it", async () => {
    const cookie = await signup("claude-code-connect@example.com");

    const malformed = await connect(cookie, "not-a-claude-token");
    expect(malformed.status).toBe(400);
    expect(JSON.stringify(await malformed.json())).toContain(
      "claude setup-token",
    );
    expect(anthropicCalls).toHaveLength(0);

    const forged = await connect(cookie, FORGED);
    expect(forged.status).toBe(400);
    expect(JSON.stringify(await forged.json())).toContain(
      "Anthropic rejected this token",
    );
    expect(anthropicCalls).toEqual([
      {
        url: "https://api.anthropic.com/v1/models?limit=1",
        authorization: `Bearer ${FORGED}`,
      },
    ]);
    const empty = (await (
      await call(`${base}/connections`, cookie)
    ).json()) as {
      data: { connections: unknown[] };
    };
    expect(empty.data.connections).toEqual([]);

    const connected = await connect(cookie, `  ${VALID}\n`);
    expect(connected.status).toBe(200);
    const body = await connected.text();
    expect(body).not.toContain(VALID);
    const connection = (
      JSON.parse(body) as {
        data: {
          id: string;
          providerId: string;
          health: { state: string; code: string };
          credential?: { present: boolean };
        };
      }
    ).data;
    expect(connection).toMatchObject({
      providerId: "claude-code",
      health: { state: "healthy", code: "CONNECTED" },
      credential: { present: true },
    });
    // The stored token is trimmed: the access check sends exactly the token.
    expect(anthropicCalls.at(-1)?.authorization).toBe(`Bearer ${VALID}`);

    const choices = (await (await call(`${base}/choices`, cookie)).json()) as {
      data: { models: { canonical: string; connectionId: string }[] };
    };
    const served = choices.data.models
      .filter(({ canonical }) => canonical.startsWith("claude-code/"))
      .map(({ canonical, connectionId }) => ({ canonical, connectionId }));
    expect(served).toContainEqual({
      canonical: "claude-code/claude-haiku-5-5",
      connectionId: connection.id,
    });
    expect(served.map(({ canonical }) => canonical)).toContain(
      "claude-code/claude-opus-5-5",
    );

    const catalog = (await (await call(`${base}/catalog`, cookie)).json()) as {
      data: { providers: { id: string; transport: string }[] };
    };
    expect(
      catalog.data.providers.find(({ id }) => id === "claude-code"),
    ).toMatchObject({ transport: "agent" });

    // One plan per owner: a second connection is refused, under any name.
    const second = await call(`${base}/connections`, cookie, "POST", {
      name: "Another Claude plan",
      kind: "provider",
      providerId: "claude-code",
      apiKey: VALID,
    });
    expect(second.status).toBe(400);
    expect(JSON.stringify(await second.json())).toContain("already connected");

    const replaced = await call(
      `${base}/connections/${connection.id}`,
      cookie,
      "PATCH",
      { apiKey: FORGED },
    );
    expect(replaced.status).toBe(400);
    expect(JSON.stringify(await replaced.json())).toContain(
      "Anthropic rejected this token",
    );
  });
});
