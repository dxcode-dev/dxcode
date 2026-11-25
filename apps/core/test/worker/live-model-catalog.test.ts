import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../../src/app.js";
import type { Bindings } from "../../src/http/types.js";
import {
  MODELS_DEV_URL,
  refreshModelsDev,
} from "../../src/settings/model-routing/live-catalog.js";
import { TEST_CONFIG_ENCRYPTION_KEYS } from "../../src/testing/bindings.js";

/**
 * A model a lab ships after dx's release reaches every model list without a
 * release: models.dev's copy lands in D1 from the cron, a Claude plan's
 * model list lands when the plan is connected, and the routes read both.
 */

const origin = "http://dx.test";
const bindings: Bindings = {
  DB: env.DB,
  DX_ENV: "local",
  DX_AUTH_URL: origin,
  DX_AUTH_TRUSTED_ORIGINS: origin,
  DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
  DX_SIGNUP_ENABLED: "true",
  BETTER_AUTH_SECRET: "live-model-catalog-secret-0000000000",
  BYOK_CREDENTIAL_COORDINATOR: env.BYOK_CREDENTIAL_COORDINATOR,
};
const base = "/v1/settings/personal/model-routing";

afterEach(() => vi.restoreAllMocks());

let signupIndex = 80;
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
      body: JSON.stringify({
        name: "Catalog Owner",
        email,
        password: "live-model-catalog-password-1",
      }),
    },
    bindings,
  );
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (cookie === undefined) throw new Error("Expected session cookie.");
  return cookie;
};

const request = (
  path: string,
  cookie: string,
  method: "GET" | "POST" = "GET",
  body?: unknown,
) =>
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

interface CatalogModel {
  readonly id: string;
  readonly name: string;
  readonly contextWindow?: number;
}
const providerModels = async (cookie: string, provider: string) => {
  const response = await request(`${base}/catalog`, cookie);
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    data: { providers: Array<{ id: string; models: CatalogModel[] }> };
  };
  return body.data.providers.find(({ id }) => id === provider)?.models ?? [];
};

/** models.dev's shape, cut to what the test needs. */
const modelsDev = {
  google: {
    id: "google",
    models: {
      // A model pi already lists: pi's entry, which knows its wire traits, wins.
      "gemini-2.5-pro": {
        id: "gemini-2.5-pro",
        name: "Renamed by models.dev",
        tool_call: true,
        reasoning: true,
        modalities: { input: ["text", "image"], output: ["text"] },
        limit: { context: 1, output: 1 },
      },
      "gemini-4-zinc": {
        id: "gemini-4-zinc",
        name: "Gemini 4 Zinc",
        tool_call: true,
        reasoning: true,
        modalities: { input: ["text", "image"], output: ["text"] },
        limit: { context: 2_000_000, output: 64_000 },
        cost: { input: 3, output: 15, cache_read: 0.3 },
      },
      // Not an agent model: speech out, no tools.
      "gemini-4-zinc-tts": {
        id: "gemini-4-zinc-tts",
        name: "Gemini 4 Zinc TTS",
        tool_call: false,
        modalities: { input: ["text"], output: ["audio"] },
        limit: { context: 32_000, output: 8_000 },
      },
      // No Gemini-family model pi serves to borrow a wire format from.
      "lyra-1": {
        id: "lyra-1",
        name: "Lyra 1",
        tool_call: true,
        modalities: { input: ["text"], output: ["text"] },
        limit: { context: 100_000, output: 8_000 },
      },
    },
  },
  // Not a provider dx serves.
  "some-other-lab": {
    id: "some-other-lab",
    models: {
      "other-1": {
        id: "other-1",
        name: "Other 1",
        tool_call: true,
        modalities: { input: ["text"], output: ["text"] },
      },
    },
  },
};

describe("live model catalog", () => {
  it("lists a model models.dev publishes after the release, without a deploy", async () => {
    const cookie = await signup("live-catalog-models-dev@example.com");
    const before = await providerModels(cookie, "google");
    expect(before.length).toBeGreaterThan(0);
    expect(before.map(({ id }) => id)).not.toContain("google/gemini-4-zinc");

    const fetched: string[] = [];
    const result = await refreshModelsDev(env.DB, {
      force: true,
      fetch: (async (input: RequestInfo | URL) => {
        fetched.push(String(input));
        return Response.json(modelsDev);
      }) as typeof fetch,
    });
    expect(fetched).toEqual([MODELS_DEV_URL]);
    expect(result).toEqual({ status: "refreshed", models: 3 });

    const after = await providerModels(cookie, "google");
    const zinc = after.find(({ id }) => id === "google/gemini-4-zinc");
    expect(zinc).toMatchObject({
      name: "Gemini 4 Zinc",
      contextWindow: 2_000_000,
    });
    expect(after.map(({ id }) => id)).not.toContain("google/gemini-4-zinc-tts");
    expect(after.map(({ id }) => id)).not.toContain("google/lyra-1");
    // Every model pi pins is still listed, unchanged.
    expect(after.filter(({ id }) => id !== "google/gemini-4-zinc")).toEqual(
      before,
    );

    // A fresh copy is not fetched again until it is hours old.
    const again = await refreshModelsDev(env.DB, {
      fetch: (async () => {
        throw new Error("models.dev must not be read while fresh");
      }) as typeof fetch,
    });
    expect(again).toEqual({ status: "fresh" });

    // A failed read keeps the last good copy.
    const failed = await refreshModelsDev(env.DB, {
      force: true,
      fetch: (async () =>
        new Response("down", { status: 503 })) as typeof fetch,
    });
    expect(failed).toEqual({ status: "failed", reason: "HTTP 503" });
    expect(
      (await providerModels(cookie, "google")).map(({ id }) => id),
    ).toContain("google/gemini-4-zinc");
  });

  it("serves the models a Claude plan lists when it is connected", async () => {
    const cookie = await signup("live-catalog-claude-plan@example.com");
    const anthropic: Array<{ url: string; authorization: string | null }> = [];
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith("https://api.anthropic.com/v1/models"))
        return realFetch(input, init);
      anthropic.push({
        url,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return Response.json({
        data: [
          {
            type: "model",
            id: "claude-opus-6",
            display_name: "Claude Opus 6",
            max_input_tokens: 2_000_000,
            max_tokens: 256_000,
            capabilities: {
              image_input: { supported: true },
              thinking: { supported: true },
            },
          },
          {
            type: "model",
            id: "claude-opus-5-5",
            display_name: "Claude Opus 5.5",
          },
        ],
        has_more: false,
      });
    });

    const created = await request(`${base}/connections`, cookie, "POST", {
      kind: "provider",
      name: "Claude plan",
      providerId: "claude-code",
      apiKey: "sk-ant-oat01-live-catalog-fixture",
    });
    expect(created.status).toBe(200);
    expect(anthropic).toEqual([
      {
        url: "https://api.anthropic.com/v1/models?limit=1000",
        authorization: "Bearer sk-ant-oat01-live-catalog-fixture",
      },
    ]);

    const choices = (await (
      await request(`${base}/choices`, cookie)
    ).json()) as {
      data: { models: Array<{ canonical: string; name: string }> };
    };
    const claude = choices.data.models.filter(({ canonical }) =>
      canonical.startsWith("claude-code/"),
    );
    // The plan's list first, newest first, then the models dx shipped with.
    expect(claude[0]).toMatchObject({
      canonical: "claude-code/claude-opus-6",
      name: "Claude Opus 6",
    });
    expect(claude.map(({ canonical }) => canonical)).toContain(
      "claude-code/claude-fable-5-2",
    );
  });
});
