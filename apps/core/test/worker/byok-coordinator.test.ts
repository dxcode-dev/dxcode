import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { createModels } from "@earendil-works/pi-ai";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settingsPersistenceLogger } from "../../src/logging.js";
import { loadConfigEncryptionKeyring } from "../../src/settings/config-encryption.js";
import { createDxModelRoutingProvider } from "../../src/settings/model-byok/flue-provider.js";
import {
  ByokCredentialCoordinatorObject,
  upstreamDns,
  upstreamFetch,
} from "../../src/settings/model-byok/invocation.js";
import {
  encodeProxyEnvelope,
  PROXY_ENVELOPE_HEADER,
  type ProxyEnvelope,
} from "../../src/settings/model-byok/proxy-envelope.js";
import { loadRoutableConnections } from "../../src/settings/model-routing/connection-store-d1.js";
import { connectionApiKey } from "../../src/settings/model-routing/credential-access.js";
import { encryptModelCredential } from "../../src/settings/model-routing/model-credential-encryption.js";
import type { SubmissionRoute } from "../../src/settings/model-routing/submission.js";
import { PersonalModelSubscriptionRepositoryD1 } from "../../src/settings/model-subscriptions/repository-d1.js";
import { PersonalModelSubscriptionService } from "../../src/settings/model-subscriptions/service.js";
import {
  pruneSubmissionUsageAttributions,
  storeSubmissionUsageAttribution,
} from "../../src/settings/usage/submission-attribution.js";
import { runDxTitleAgent } from "../../src/threads/dx-title-agent.js";

/**
 * Coordinator DO transport tests. DOs run in the same isolate as the test
 * worker, so patching `globalThis.fetch` intercepts the coordinator's
 * outbound upstream calls.
 */

const OWNER = "coord-owner";
const PROJECT = "coord-project";
const THREAD = "coord-thread";
const CONNECTION = "mcon_coord";
const CREDENTIAL = "mcred_coord";
const UPSTREAM = "https://upstream.test";

const now = "2026-09-01T00:00:00.000Z";

type TestProxyEnvelope = ProxyEnvelope & {
  readonly request: ProxyEnvelope["request"] & { readonly body: unknown };
};

/** The `/proxy` wire shape: routing envelope header plus the raw body. */
const proxyInit = (envelope: Record<string, unknown>): RequestInit => {
  const { request, ...route } = envelope as unknown as TestProxyEnvelope;
  const { body, ...metadata } = request;
  return {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      [PROXY_ENVELOPE_HEADER]: encodeProxyEnvelope({
        ...route,
        request: metadata,
      }),
    },
    body: JSON.stringify(body),
  };
};

const seed = async (apiKey = "sk-litellm-real") => {
  await runInDurableObject(stub(), async (_instance, state) =>
    state.storage.deleteAll(),
  );
  const keyring = await Effect.runPromise(
    loadConfigEncryptionKeyring(env as never),
  );
  const envelope = await Effect.runPromise(
    encryptModelCredential(
      keyring,
      {
        id: CREDENTIAL as never,
        target: { scope: "personal", id: OWNER as never },
        name: "litellm-key",
      },
      apiKey as never,
    ),
  );
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
    ).bind(OWNER, "Owner", "owner@dx.test", now, now),
    env.DB.prepare(
      "INSERT INTO projects (id, owner_user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(PROJECT, OWNER, "Coord project", now, now),
    env.DB.prepare(
      "INSERT INTO threads (id, project_id, owner_user_id, model_selection, lifecycle_state, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)",
    ).bind(
      THREAD,
      PROJECT,
      OWNER,
      JSON.stringify({ kind: "model", model: "openai/gpt-6-astra" }),
      now,
      now,
    ),
    env.DB.prepare(
      "INSERT INTO model_credential (id, scope, target_id, name, envelope_version, key_version, value_nonce, ciphertext, wrapped_key_nonce, wrapped_key, created_at, updated_at) VALUES (?, 'personal', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      CREDENTIAL,
      OWNER,
      "litellm-key",
      envelope.version,
      envelope.keyVersion,
      envelope.valueNonce,
      envelope.ciphertext,
      envelope.wrappedKeyNonce,
      envelope.wrappedKey,
      now,
      now,
    ),
    env.DB.prepare(
      "INSERT INTO model_connection (id, scope, target_id, name, kind, provider_id, base_url, format, fields, enabled, priority, model_credential_id, created_at, updated_at) VALUES (?, 'personal', ?, ?, 'custom', 'dx-custom', ?, 'openai-completions', '{}', 1, 0, ?, ?, ?)",
    ).bind(CONNECTION, OWNER, "LiteLLM", UPSTREAM, CREDENTIAL, now, now),
    env.DB.prepare(
      "INSERT INTO model_connection_model (connection_id, canonical, upstream, position) VALUES (?, ?, ?, 0)",
    ).bind(CONNECTION, "openai/gpt-6-astra", "astra-litellm"),
    env.DB.prepare(
      "INSERT INTO model_connection_header (connection_id, name, value, position) VALUES (?, ?, ?, 0)",
    ).bind(CONNECTION, "x-tenant", "tenant-1"),
  ]);
  const response = await prepare();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ model: "openai/gpt-6-astra" });
};

const stub = () =>
  env.BYOK_CREDENTIAL_COORDINATOR.get(
    env.BYOK_CREDENTIAL_COORDINATOR.idFromName(`byok-${THREAD}`),
  );

const proxyEnvelope = (overrides: Record<string, unknown> = {}) => ({
  threadId: THREAD,
  submissionId: "sub-1",
  canonical: "openai/gpt-6-astra",
  request: {
    url: `${UPSTREAM}/chat/completions`,
    method: "POST",
    headers: {
      authorization: "Bearer dx-placeholder",
      "content-type": "application/json",
      host: "upstream.test",
      "content-length": "10",
    },
    body: { model: "dx-placeholder", messages: [] },
  },
  ...overrides,
});

// Consume DO bodies so an eviction does not wait on earlier test responses.
const drained = async (response: Response) =>
  new Response(await response.arrayBuffer(), response);

const callProxy = (envelope: Record<string, unknown>) =>
  stub().fetch("https://coordinator/proxy", proxyInit(envelope)).then(drained);

const prepare = (submissionId = "sub-1", recovery = false) =>
  stub()
    .fetch("https://coordinator/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId: THREAD, submissionId, recovery }),
    })
    .then(drained);

const realFetch = upstreamFetch.current;
const realDns = upstreamDns.current;
beforeEach(() => {
  upstreamDns.current = async () => ["8.8.8.8"];
});
afterEach(() => {
  upstreamFetch.current = realFetch;
  upstreamDns.current = realDns;
  vi.restoreAllMocks();
});

const stubFetch = (
  responder: (request: Request) => Response | Promise<Response>,
) => {
  upstreamFetch.current = (async (input: unknown, init?: RequestInit) =>
    responder(new Request(input as never, init as never))) as never;
};

const connectionHealth = async () =>
  env.DB.prepare(
    "SELECT health_state, health_code FROM model_connection WHERE id = ?",
  )
    .bind(CONNECTION)
    .first<{ health_state: string; health_code: string }>();

describe("ByokCredentialCoordinatorObject", () => {
  it("refuses new preparation rather than evicting a live submission route", async () => {
    await seed();
    await runInDurableObject(stub(), async (_instance, state) => {
      const expiresAt = Date.now() + 100_000;
      for (let index = 2; index <= 512; index += 1)
        await state.storage.put(`submission-route:capacity-${index}`, {
          expiresAt,
        });
    });

    const overflow = await prepare("sub-overflow");
    expect(overflow.status).not.toBe(200);
    expect(await overflow.json()).toMatchObject({
      code: "MODEL_ROUTING_UNAVAILABLE",
    });
    stubFetch(async () => Response.json({ ok: true }));
    expect((await callProxy(proxyEnvelope())).status).toBe(200);
    const routes = await runInDurableObject(stub(), (_instance, state) =>
      state.storage.list({ prefix: "submission-route:" }),
    );
    expect(routes.size).toBe(512);
    expect(routes.has("submission-route:sub-1")).toBe(true);
  });

  it("renews a submission route while model calls keep using it", async () => {
    await seed();
    const nearExpiry = await runInDurableObject(
      stub(),
      async (_instance, state) => {
        const pin = await state.storage.get<{ expiresAt: number }>(
          "submission-route:sub-1",
        );
        if (pin === undefined) throw new Error("Missing pin");
        const expiresAt = Date.now() + 60_000;
        await state.storage.put("submission-route:sub-1", {
          ...pin,
          expiresAt,
        });
        return expiresAt;
      },
    );
    stubFetch(async () => Response.json({ ok: true }));
    expect((await callProxy(proxyEnvelope())).status).toBe(200);
    const renewed = await runInDurableObject(stub(), (_instance, state) =>
      state.storage.get<{ expiresAt: number; credential?: unknown }>(
        "submission-route:sub-1",
      ),
    );
    expect(renewed?.expiresAt).toBeGreaterThan(
      nearExpiry + 23 * 60 * 60 * 1_000,
    );
    expect(renewed?.credential).toBeDefined();
  });

  it("retains safe immutable attribution after the next submission and prunes expired entries in batches", async () => {
    await seed();
    await env.DB.prepare(
      "UPDATE model_connection_model SET canonical = 'openai/gpt-5.6-luna' WHERE connection_id = ?",
    )
      .bind(CONNECTION)
      .run();
    await env.DB.prepare("UPDATE threads SET model_selection = ? WHERE id = ?")
      .bind(
        JSON.stringify({ kind: "model", model: "openai/gpt-5.6-luna" }),
        THREAD,
      )
      .run();
    expect((await prepare("sub-2")).status).toBe(200);
    const lookup = (threadId: string, submissionId: string) =>
      stub()
        .fetch("https://coordinator/usage-route", {
          method: "POST",
          body: JSON.stringify({ threadId, submissionId }),
        })
        .then(drained);
    await expect((await lookup(THREAD, "sub-1")).json()).resolves.toEqual({
      connectionId: CONNECTION,
      providerId: "openai",
      modelId: "gpt-6-astra",
    });
    await expect((await lookup(THREAD, "sub-2")).json()).resolves.toEqual({
      connectionId: CONNECTION,
      providerId: "openai",
      modelId: "gpt-5.6-luna",
    });
    expect((await lookup("other-thread", "sub-1")).status).toBe(404);
    await runInDurableObject(stub(), async (_instance, state) => {
      const expiresAt = Date.now() + 100_000;
      for (let i = 0; i < 129; i++) {
        await state.storage.put(`usage-attribution:expired-${i}`, {
          threadId: THREAD,
          submissionId: `expired-${i}`,
          expiresAt,
        });
      }
      expect(
        await pruneSubmissionUsageAttributions(
          state.storage,
          new Date(expiresAt + 1),
        ),
      ).toBe(128);
      expect(
        await pruneSubmissionUsageAttributions(
          state.storage,
          new Date(expiresAt + 2),
        ),
      ).toBe(1);
      await storeSubmissionUsageAttribution(
        state.storage,
        THREAD,
        "sub-1",
        { connectionId: "wrong", providerId: "wrong", modelId: "wrong" },
        new Date(),
      );
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
    await expect((await lookup(THREAD, "sub-1")).json()).resolves.toEqual({
      connectionId: CONNECTION,
      providerId: "openai",
      modelId: "gpt-6-astra",
    });
  });

  it("keeps the encrypted credential paired with its endpoint across rotation and eviction", async () => {
    await seed();
    const keyring = await Effect.runPromise(
      loadConfigEncryptionKeyring(env as never),
    );
    const replacement = await Effect.runPromise(
      encryptModelCredential(
        keyring,
        {
          id: "mcred_rotated" as never,
          target: { scope: "personal", id: OWNER as never },
          name: "rotated",
        },
        "sk-new-endpoint" as never,
      ),
    );
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO model_credential (id, scope, target_id, name, envelope_version, key_version, value_nonce, ciphertext, wrapped_key_nonce, wrapped_key, created_at, updated_at) VALUES ('mcred_rotated', 'personal', ?, 'rotated', 1, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        OWNER,
        replacement.keyVersion,
        replacement.valueNonce,
        replacement.ciphertext,
        replacement.wrappedKeyNonce,
        replacement.wrappedKey,
        now,
        now,
      ),
      env.DB.prepare(
        "UPDATE model_connection SET model_credential_id = 'mcred_rotated', base_url = 'https://new.example.com' WHERE id = ?",
      ).bind(CONNECTION),
      env.DB.prepare("DELETE FROM model_credential WHERE id = ?").bind(
        CREDENTIAL,
      ),
    ]);
    await evictDurableObject(stub());
    const calls: { url: string; key: string | null }[] = [];
    stubFetch((request) => {
      calls.push({
        url: request.url,
        key: request.headers.get("authorization"),
      });
      return Response.json({ ok: true });
    });
    expect((await prepare("sub-1", true)).status).toBe(200);
    expect((await callProxy(proxyEnvelope())).status).toBe(200);
    expect((await prepare("sub-2")).status).toBe(200);
    const next = proxyEnvelope({ submissionId: "sub-2" });
    next.request.url = "https://new.example.com/chat/completions";
    expect((await callProxy(next)).status).toBe(200);
    expect((await callProxy(proxyEnvelope())).status).toBe(200);
    expect(calls).toEqual([
      { url: `${UPSTREAM}/chat/completions`, key: "Bearer sk-litellm-real" },
      {
        url: "https://new.example.com/chat/completions",
        key: "Bearer sk-new-endpoint",
      },
      { url: `${UPSTREAM}/chat/completions`, key: "Bearer sk-litellm-real" },
    ]);
    const stored = await runInDurableObject(stub(), (_instance, state) =>
      state.storage.list({ prefix: "submission-route:" }),
    );
    expect(JSON.stringify([...stored.values()])).not.toContain(
      "sk-new-endpoint",
    );
  });

  it("rejects a model removed by a Copilot entitlement refresh before resolving access", async () => {
    await seed();
    const row = {
      status: "connected",
      modelIds: ["astra-litellm"],
      refreshAfter: now,
    };
    const find = vi
      .spyOn(PersonalModelSubscriptionRepositoryD1.prototype, "find")
      .mockResolvedValueOnce(row as never)
      .mockResolvedValueOnce({ ...row, modelIds: [] } as never);
    const refresh = vi
      .spyOn(PersonalModelSubscriptionService.prototype, "refresh")
      .mockResolvedValue(undefined as never);
    const access = vi.spyOn(
      PersonalModelSubscriptionService.prototype,
      "resolveAccess",
    );
    const response = await runInDurableObject(
      stub(),
      async (_instance, state) => {
        const pin = await state.storage.get<SubmissionRoute>(
          "submission-route:sub-1",
        );
        if (pin === undefined) throw new Error("Expected seeded route");
        await state.storage.put("submission-route:sub-1", {
          ...pin,
          connection: { ...pin.connection, kind: "subscription" },
        });
        const coordinator = new ByokCredentialCoordinatorObject(state, {
          ...env,
          DX_GITHUB_COPILOT_CLIENT_ID: "test-client",
        } as never);
        return drained(
          await coordinator.fetch(
            new Request(
              "https://coordinator/proxy",
              proxyInit(proxyEnvelope()),
            ),
          ),
        );
      },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      code: "SUBSCRIPTION_NOT_CONNECTED",
    });
    expect(find).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledOnce();
    expect(access).not.toHaveBeenCalled();
  });

  it("ignores reserved persisted headers before transport", async () => {
    await seed();
    await env.DB.batch(
      ["x-api-key", "host", "Authorization"].map((name, index) =>
        env.DB.prepare(
          "INSERT INTO model_connection_header (connection_id, name, value, position) VALUES (?, ?, 'untrusted', ?)",
        ).bind(CONNECTION, name, index + 1),
      ),
    );
    await prepare("reserved-headers");
    stubFetch((request) => {
      expect(request.headers.get("x-api-key")).toBeNull();
      expect(request.headers.get("host")).toBeNull();
      expect(request.headers.get("authorization")).toBe(
        "Bearer sk-litellm-real",
      );
      expect(request.headers.get("x-tenant")).toBe("tenant-1");
      return Response.json({ ok: true });
    });
    expect(
      (await callProxy(proxyEnvelope({ submissionId: "reserved-headers" })))
        .status,
    ).toBe(200);
  });

  it("rejects a /proxy call without a well-formed routing envelope", async () => {
    for (const header of [undefined, "not base64!", "e30"]) {
      const response = await stub().fetch("https://coordinator/proxy", {
        method: "POST",
        headers:
          header === undefined ? {} : { [PROXY_ENVELOPE_HEADER]: header },
        body: "{}",
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ code: "INVALID_REQUEST" });
    }
  });

  it("retains malformed JSON as a 400 response", async () => {
    const response = await stub().fetch("https://coordinator/resolve", {
      method: "POST",
      body: "{not-json",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "INVALID_REQUEST" });
  });

  it("rejects mixed public and private DNS answers before sending credentials", async () => {
    await seed();
    upstreamDns.current = async () => ["8.8.8.8", "10.0.0.1"];
    const transport = vi.fn(() => new Response("must not be called"));
    stubFetch(transport);
    const response = await stub().fetch(
      "https://dx-byok.invalid/proxy",
      proxyInit(proxyEnvelope()),
    );
    expect(response.status).toBe(403);
    await response.text();
    expect(transport).not.toHaveBeenCalled();
  });

  it("decrypts the seeded credential directly", async () => {
    await seed();
    const keyring = await Effect.runPromise(
      loadConfigEncryptionKeyring(env as never),
    );
    const row = await env.DB.prepare(
      "SELECT model_credential_id FROM model_connection WHERE id = ?",
    )
      .bind(CONNECTION)
      .first<{ model_credential_id: string }>();
    expect(row?.model_credential_id).toBe(CREDENTIAL);
    const plaintext = await connectionApiKey(env.DB, keyring, {
      id: CONNECTION as never,
      target: { scope: "personal", id: OWNER as never },
      credentialId: CREDENTIAL as never,
    } as never);
    expect(plaintext).toBe("sk-litellm-real");
  });

  it("resolves and decrypts through the DO's own path", async () => {
    await seed();
    const keyring = await Effect.runPromise(
      loadConfigEncryptionKeyring(env as never),
    );
    const connections = await loadRoutableConnections(env.DB, OWNER);
    expect(connections).toHaveLength(1);
    expect(connections[0]!.credentialId).toBe(CREDENTIAL);
    const plaintext = await connectionApiKey(env.DB, keyring, connections[0]!);
    expect(plaintext).toBe("sk-litellm-real");
  });

  it("swaps credentials, pins origin, applies headers and renames the model", async () => {
    await seed();
    let upstreamBody = "";
    let upstreamHeaders: Headers | undefined;
    stubFetch(async (request) => {
      upstreamBody = await request.clone().text();
      upstreamHeaders = request.headers;
      return Response.json({ ok: true }, { status: 200 });
    });
    const response = await callProxy(proxyEnvelope());
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(upstreamHeaders).toBeDefined();
    expect(upstreamHeaders!.get("authorization")).toBe(
      "Bearer sk-litellm-real",
    );
    expect(upstreamHeaders!.get("x-tenant")).toBe("tenant-1");
    expect(upstreamHeaders!.get("host")).toBeNull();
    const parsed = JSON.parse(upstreamBody) as { model?: string };
    expect(parsed.model).toBe("astra-litellm");
  });

  it("forwards a multi-megabyte body unchanged apart from the model rename", async () => {
    await seed();
    const content = "x".repeat(6 * 1_048_576);
    let upstream: { model?: string; messages?: Array<{ content: string }> } =
      {};
    stubFetch(async (request) => {
      upstream = (await request.json()) as typeof upstream;
      return Response.json({ ok: true });
    });
    const response = await callProxy(
      proxyEnvelope({
        request: {
          url: `${UPSTREAM}/chat/completions`,
          method: "POST",
          headers: { authorization: "Bearer dx-placeholder" },
          body: { model: "dx-placeholder", messages: [{ content }] },
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(upstream.model).toBe("astra-litellm");
    expect(upstream.messages?.[0]?.content).toHaveLength(content.length);
  });

  it("refuses cross-origin request urls", async () => {
    await seed();
    const response = await callProxy(
      proxyEnvelope({
        request: {
          url: "https://evil.example/chat/completions",
          method: "POST",
          headers: { authorization: "Bearer dx-placeholder" },
          body: { model: "x" },
        },
      }),
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe(
      "ORIGIN_MISMATCH",
    );
  });

  it("refuses upstream redirects", async () => {
    await seed();
    stubFetch(
      async () =>
        new Response(null, { status: 301, headers: { location: "https://x" } }),
    );
    const response = await callProxy(proxyEnvelope());
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe(
      "ENDPOINT_REDIRECT",
    );
  });

  it("does not mutate connection health when an upstream request is aborted", async () => {
    await seed();
    await env.DB.prepare(
      "UPDATE model_connection SET health_state = 'healthy', health_code = 'CONNECTED' WHERE id = ?",
    )
      .bind(CONNECTION)
      .run();
    stubFetch(async () => {
      throw new DOMException("Aborted", "AbortError");
    });
    const response = await callProxy(proxyEnvelope());
    expect(response.status).toBe(499);
    expect(await response.json()).toEqual({ code: "REQUEST_CANCELLED" });
    expect(await connectionHealth()).toMatchObject({
      health_state: "healthy",
      health_code: "CONNECTED",
    });
  });

  it("marks a genuine upstream network failure unhealthy", async () => {
    await seed();
    stubFetch(async () => {
      throw new TypeError("network failed");
    });
    const response = await callProxy(proxyEnvelope());
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ code: "UPSTREAM_UNREACHABLE" });
    await vi.waitFor(async () => {
      expect(await connectionHealth()).toMatchObject({
        health_state: "unhealthy",
        health_code: "NETWORK_ERROR",
      });
    });
  });

  it("streams the upstream response back", async () => {
    await seed();
    stubFetch(
      async () =>
        new Response("data: chunk\n\ndata: [DONE]\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    );
    const response = await callProxy(proxyEnvelope());
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("[DONE]");
  });

  it("logs a provider rejection body without the credential and forwards it unchanged", async () => {
    await seed();
    const rejection = JSON.stringify({
      type: "error",
      error: {
        type: "invalid_request_error",
        message:
          "messages.4.content.0.tool_result: content cannot be empty if `is_error` is true (key sk-litellm-real)",
      },
    });
    stubFetch(
      async () =>
        new Response(rejection, {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    );
    const warn = vi.spyOn(settingsPersistenceLogger, "warn");
    const response = await callProxy(proxyEnvelope());
    expect(response.status).toBe(400);
    expect(await response.text()).toBe(rejection);
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        "Model provider rejected the request.",
        {
          event: "model_upstream_rejected",
          threadId: THREAD,
          submissionId: "sub-1",
          connectionId: CONNECTION,
          model: expect.any(String),
          status: 400,
          body: rejection.replace("sk-litellm-real", "[REDACTED]"),
        },
      ),
    );
  });

  it("redacts a credential the provider echoes JSON-escaped", async () => {
    const apiKey = 'sk-"quoted\\key';
    await seed(apiKey);
    const rejection = JSON.stringify({
      error: { message: `bad key ${apiKey}` },
    });
    expect(rejection).not.toContain(apiKey);
    stubFetch(async () => new Response(rejection, { status: 401 }));
    const warn = vi.spyOn(settingsPersistenceLogger, "warn");
    const response = await callProxy(proxyEnvelope());
    expect(response.status).toBe(401);
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        "Model provider rejected the request.",
        expect.objectContaining({
          body: '{"error":{"message":"bad key [REDACTED]"}}',
        }),
      ),
    );
  });

  it("redacts a short API key the provider echoes", async () => {
    await seed("k9");
    const rejection = JSON.stringify({ error: { message: "bad key k9" } });
    stubFetch(async () => new Response(rejection, { status: 401 }));
    const warn = vi.spyOn(settingsPersistenceLogger, "warn");
    const response = await callProxy(proxyEnvelope());
    expect(response.status).toBe(401);
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        "Model provider rejected the request.",
        expect.objectContaining({
          body: '{"error":{"message":"bad key [REDACTED]"}}',
        }),
      ),
    );
  });

  it("redacts custom header values the provider echoes", async () => {
    await seed();
    const rejection = JSON.stringify({
      error: { message: "tenant tenant-1 rejected key sk-litellm-real" },
    });
    stubFetch(async () => new Response(rejection, { status: 403 }));
    const warn = vi.spyOn(settingsPersistenceLogger, "warn");
    const response = await callProxy(proxyEnvelope());
    expect(response.status).toBe(403);
    expect(await response.text()).toBe(rejection);
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        "Model provider rejected the request.",
        expect.objectContaining({
          body: '{"error":{"message":"tenant [REDACTED] rejected key [REDACTED]"}}',
        }),
      ),
    );
  });

  it("forwards an endless provider rejection while logging a bounded prefix", async () => {
    await seed();
    const chunk = new TextEncoder().encode("x".repeat(1_024));
    stubFetch(
      async () =>
        new Response(
          new ReadableStream({
            pull: (controller) => controller.enqueue(chunk),
          }),
          { status: 413 },
        ),
    );
    const warn = vi.spyOn(settingsPersistenceLogger, "warn");
    const response = await stub().fetch(
      "https://coordinator/proxy",
      proxyInit(proxyEnvelope()),
    );
    expect(response.status).toBe(413);
    const reader = response.body?.getReader();
    expect((await reader?.read())?.done).toBe(false);
    await reader?.cancel();
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        "Model provider rejected the request.",
        expect.objectContaining({ status: 413, body: "x".repeat(2_000) }),
      ),
    );
  });

  it("fails closed when no connection serves the model", async () => {
    await seed();
    await env.DB.prepare("UPDATE threads SET model_selection = ? WHERE id = ?")
      .bind(
        JSON.stringify({ kind: "model", model: "openai/gpt-5.6-luna" }),
        THREAD,
      )
      .run();
    const response = await prepare("sub-2");
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe(
      "MODEL_NOT_SERVED: openai/gpt-5.6-luna",
    );
  });

  it("fails closed for an unknown thread", async () => {
    const response = await stub().fetch("https://coordinator/resolve", {
      method: "POST",
      body: JSON.stringify({
        threadId: "missing-thread",
        submissionId: "missing-submission",
      }),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe(
      "THREAD_ROUTE_NOT_FOUND",
    );
  });

  it("rejects a connection disabled after preparation before the model call", async () => {
    await seed();
    const upstream = vi.fn(async () => Response.json({ ok: true }));
    stubFetch(upstream);
    await env.DB.prepare("UPDATE model_connection SET enabled = 0 WHERE id = ?")
      .bind(CONNECTION)
      .run();
    const response = await callProxy(proxyEnvelope({ submissionId: "sub-1" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "CONNECTION_REMOVED" });
    expect(upstream).not.toHaveBeenCalled();
    const pin = await runInDurableObject(stub(), (_instance, state) =>
      state.storage.get("submission-route:sub-1"),
    );
    expect(pin).not.toHaveProperty("credential");
    const next = await prepare("sub-2");
    expect(next.status).toBe(400);
    expect(((await next.json()) as { code: string }).code).toBe(
      "MODEL_NOT_SERVED: openai/gpt-6-astra",
    );
  });

  it("rejects deletion before the next call without selecting another connection", async () => {
    await seed();
    const upstream = vi.fn(async () => Response.json({ ok: true }));
    stubFetch(upstream);
    expect((await callProxy(proxyEnvelope())).status).toBe(200);
    await env.DB.prepare("DELETE FROM model_connection WHERE id = ?")
      .bind(CONNECTION)
      .run();
    const response = await callProxy(proxyEnvelope());
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "CONNECTION_REMOVED" });
    expect(upstream).toHaveBeenCalledOnce();
    const pin = await runInDurableObject(stub(), (_instance, state) =>
      state.storage.get("submission-route:sub-1"),
    );
    expect(pin).not.toHaveProperty("credential");
  });

  it("persists the exact model and connection before dispatch and keeps recovery stable", async () => {
    await seed();
    const saved = await runInDurableObject(stub(), async (_instance, state) =>
      state.storage.get<{
        submissionId: string;
        model: { baseUrl: string };
        connection: { id: string };
      }>("submission-route:sub-1"),
    );
    expect(saved).toMatchObject({
      submissionId: "sub-1",
      connection: { id: CONNECTION },
      model: { baseUrl: UPSTREAM },
    });
    await env.DB.prepare(
      "UPDATE model_connection SET base_url = ?, enabled = 0 WHERE id = ?",
    )
      .bind("https://replacement.test/v9", CONNECTION)
      .run();
    await evictDurableObject(stub());
    expect((await prepare("sub-1", true)).status).toBe(200);
    const response = await stub().fetch("https://coordinator/model", {
      method: "POST",
      body: JSON.stringify({
        threadId: THREAD,
        submissionId: "sub-1",
        canonical: "openai/gpt-6-astra",
      }),
    });
    expect(await response.json()).toMatchObject({
      baseUrl: UPSTREAM,
      api: "openai-completions",
    });
    expect((await prepare("unknown-recovery", true)).status).toBe(400);
  });

  it("rejects a different canonical model on a prepared submission", async () => {
    await seed();
    const response = await callProxy(
      proxyEnvelope({ canonical: "openai/gpt-5.6-luna" }),
    );
    expect(await response.json()).toEqual({
      code: "SUBMISSION_MODEL_MISMATCH",
    });
  });

  it("delivers a 9 MB conversation through the real adapter and coordinator", async () => {
    await seed();
    const { provider, options } = createDxModelRoutingProvider("openai", {
      namespace: env.BYOK_CREDENTIAL_COORDINATOR,
      identity: () => ({ name: THREAD }) as never,
      invocation: () =>
        ({ scope: { kind: "prompt", submissionId: "sub-1" } }) as never,
    });
    const model = await options.resolveModel!(
      { providerId: "openai", modelId: "gpt-6-astra" },
      {
        instanceId: THREAD,
        agentName: "dx-agent",
        recovery: false,
        scope: { kind: "prompt", submissionId: "sub-1" },
        signal: new AbortController().signal,
      },
    );
    if (!model) throw new Error("Missing resolved model");
    // Larger than the failing thread's 3.1 MB request and the former caps.
    const turns = Array.from({ length: 1_000 }, (_, index) => ({
      role: "user" as const,
      content: `turn ${index}: ${"const value = compute(input);\n".repeat(300)}`,
      timestamp: 0,
    }));
    let upstreamBytes = 0;
    let upstream: { model?: string; messages?: Array<{ content: unknown }> } =
      {};
    stubFetch(async (request) => {
      const text = await request.text();
      upstreamBytes = text.length;
      upstream = JSON.parse(text) as typeof upstream;
      return new Response(
        `data: ${JSON.stringify({
          id: "chat-test",
          object: "chat.completion.chunk",
          created: 0,
          model: "astra-litellm",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "ok" },
              finish_reason: "stop",
            },
          ],
        })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const models = createModels();
    models.setProvider(provider);
    const result = await models
      .streamSimple(model, { messages: turns }, { reasoning: "low" })
      .result();
    expect(result.stopReason).toBe("stop");
    expect(upstreamBytes).toBeGreaterThan(9_000_000);
    expect(upstream.model).toBe("astra-litellm");
    expect(upstream.messages?.at(-1)?.content).toBe(turns.at(-1)?.content);
  });

  it("streams through real pi-ai auth, adapter, coordinator and upstream rename", async () => {
    await seed();
    const { provider, options } = createDxModelRoutingProvider("openai", {
      namespace: env.BYOK_CREDENTIAL_COORDINATOR,
      identity: () => ({ name: THREAD }) as never,
      invocation: () =>
        ({ scope: { kind: "prompt", submissionId: "sub-1" } }) as never,
    });
    const model = await options.resolveModel!(
      { providerId: "openai", modelId: "gpt-6-astra" },
      {
        instanceId: THREAD,
        agentName: "dx-agent",
        recovery: false,
        scope: { kind: "prompt", submissionId: "sub-1" },
        signal: new AbortController().signal,
      },
    );
    if (!model) throw new Error("Missing resolved model");
    // Flue compacts against dx's effective window, not the native 1.05M.
    expect(model.contextWindow).toBe(270_000);
    const calls: {
      url: string;
      authorization: string | null;
      body: unknown;
    }[] = [];
    stubFetch(async (request) => {
      calls.push({
        url: request.url,
        authorization: request.headers.get("authorization"),
        body: await request.json(),
      });
      return new Response(
        `${[
          {
            id: "chat-test",
            object: "chat.completion.chunk",
            created: 0,
            model: "astra-litellm",
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: "route verified" },
                finish_reason: null,
              },
            ],
          },
          {
            id: "chat-test",
            object: "chat.completion.chunk",
            created: 0,
            model: "astra-litellm",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          },
        ]
          .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
          .join("")}data: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const models = createModels();
    models.setProvider(provider);
    const stream = models.streamSimple(
      model,
      {
        messages: [
          { role: "user", content: "Say route verified", timestamp: 0 },
        ],
      },
      { reasoning: "low" },
    );
    expect(stream.result).toBeTypeOf("function");
    const result = await stream.result();
    expect(result.stopReason).toBe("stop");
    expect(result.content).toContainEqual({
      type: "text",
      text: "route verified",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: `${UPSTREAM}/chat/completions`,
      authorization: "Bearer sk-litellm-real",
      body: { model: "astra-litellm" },
    });
  });

  it("sends an Anthropic custom endpoint saved with /v1 to one /v1/messages and probes the same base", async () => {
    await seed();
    await env.DB.prepare(
      "UPDATE model_connection SET base_url = ?, format = 'anthropic-messages' WHERE id = ?",
    )
      .bind(`${UPSTREAM}/v1`, CONNECTION)
      .run();
    expect((await prepare("sub-anthropic")).status).toBe(200);
    const { provider, options } = createDxModelRoutingProvider("openai", {
      namespace: env.BYOK_CREDENTIAL_COORDINATOR,
      identity: () => ({ name: THREAD }) as never,
      invocation: () =>
        ({ scope: { kind: "prompt", submissionId: "sub-anthropic" } }) as never,
    });
    const model = await options.resolveModel!(
      { providerId: "openai", modelId: "gpt-6-astra" },
      {
        instanceId: THREAD,
        agentName: "dx-agent",
        recovery: false,
        scope: { kind: "prompt", submissionId: "sub-anthropic" },
        signal: new AbortController().signal,
      },
    );
    if (!model) throw new Error("Missing resolved model");
    expect(model).toMatchObject({
      api: "anthropic-messages",
      baseUrl: UPSTREAM,
    });
    const calls: { url: string; apiKey: string | null; body: unknown }[] = [];
    stubFetch(async (request) => {
      if (request.method === "GET") {
        calls.push({ url: request.url, apiKey: null, body: null });
        return Response.json({ data: [] });
      }
      calls.push({
        url: request.url,
        apiKey: request.headers.get("x-api-key"),
        body: await request.json(),
      });
      const events = [
        {
          type: "message_start",
          message: {
            id: "msg_test",
            type: "message",
            role: "assistant",
            model: "astra-litellm",
            content: [],
            stop_reason: null,
            usage: { input_tokens: 3, output_tokens: 0 },
          },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "anthropic route verified" },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 4 },
        },
        { type: "message_stop" },
      ];
      return new Response(
        events
          .map(
            (event) =>
              `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          )
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const models = createModels();
    models.setProvider(provider);
    const result = await models
      .streamSimple(model, {
        messages: [{ role: "user", content: "Say it", timestamp: 0 }],
      })
      .result();
    expect(result.stopReason).toBe("stop");
    expect(result.content).toContainEqual({
      type: "text",
      text: "anthropic route verified",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: `${UPSTREAM}/v1/messages?beta=true`,
      apiKey: "sk-litellm-real",
      body: { model: "astra-litellm" },
    });

    const check = await stub().fetch("https://coordinator/check", {
      method: "POST",
      body: JSON.stringify({
        target: { scope: "personal", id: OWNER },
        connectionId: CONNECTION,
      }),
    });
    expect(await check.json()).toMatchObject({ health: { state: "healthy" } });
    expect(calls[1]?.url).toBe(`${UPSTREAM}/v1/models`);
  });

  it("checks access at the configured base path with custom headers", async () => {
    await seed();
    await env.DB.prepare(
      "UPDATE model_connection SET base_url = ? WHERE id = ?",
    )
      .bind(`${UPSTREAM}/tenant/v1/`, CONNECTION)
      .run();
    const calls: string[] = [];
    stubFetch(async (request) => {
      calls.push(request.url);
      expect(request.headers.get("x-tenant")).toBe("tenant-1");
      return Response.json({ data: [] });
    });
    const response = await stub().fetch("https://coordinator/check", {
      method: "POST",
      body: JSON.stringify({
        target: { scope: "personal", id: OWNER },
        connectionId: CONNECTION,
      }),
    });
    expect(await response.json()).toMatchObject({
      health: { state: "healthy" },
    });
    expect(calls).toEqual([`${UPSTREAM}/tenant/v1/models`]);
  });

  it("keeps a mode's model during a submission and applies its edit at the next boundary", async () => {
    await seed();
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE threads SET model_selection = ? WHERE id = ?",
      ).bind(
        JSON.stringify({ kind: "mode", profileId: "default", mode: "low" }),
        THREAD,
      ),
      env.DB.prepare(
        "INSERT INTO mode_profile_override (user_id, profile_id, mode, config, updated_at) VALUES (?, 'default', 'low', ?, ?)",
      ).bind(
        OWNER,
        JSON.stringify({
          agent: { model: "openai/gpt-6-astra", thinking: "low" },
        }),
        now,
      ),
      env.DB.prepare(
        "INSERT INTO model_connection_model (connection_id, canonical, upstream, position) VALUES (?, ?, ?, 1)",
      ).bind(CONNECTION, "openai/gpt-5.6-luna", "luna-litellm"),
    ]);
    expect(await (await prepare("mode-1")).json()).toEqual({
      model: "openai/gpt-6-astra",
      thinking: "low",
    });
    await env.DB.prepare(
      "UPDATE mode_profile_override SET config = ? WHERE user_id = ?",
    )
      .bind(
        JSON.stringify({
          agent: { model: "openai/gpt-5.6-luna", thinking: "high" },
        }),
        OWNER,
      )
      .run();
    expect(await (await prepare("mode-1", true)).json()).toEqual({
      model: "openai/gpt-6-astra",
      thinking: "low",
    });
    expect(await (await prepare("mode-2")).json()).toEqual({
      model: "openai/gpt-5.6-luna",
      thinking: "high",
    });
    const route = await runInDurableObject(stub(), (_instance, state) =>
      state.storage.get<{ upstreamModel: string }>("submission-route:mode-2"),
    );
    expect(route?.upstreamModel).toBe("luna-litellm");
  });

  it("never retries inside the adapter or falls back on upstream 503", async () => {
    await seed();
    const { provider, options } = createDxModelRoutingProvider("openai", {
      namespace: env.BYOK_CREDENTIAL_COORDINATOR,
      identity: () => ({ name: THREAD }) as never,
      invocation: () =>
        ({ scope: { kind: "prompt", submissionId: "sub-1" } }) as never,
    });
    const model = await options.resolveModel!(
      { providerId: "openai", modelId: "gpt-6-astra" },
      {
        instanceId: THREAD,
        agentName: "dx-agent",
        recovery: false,
        scope: { kind: "prompt", submissionId: "sub-1" },
        signal: new AbortController().signal,
      },
    );
    if (!model) throw new Error("Missing model");
    const calls = vi.fn(async () =>
      Response.json({ error: { message: "Unavailable" } }, { status: 503 }),
    );
    stubFetch(calls);
    const result = await provider
      .streamSimple(
        model,
        { messages: [{ role: "user", content: "test", timestamp: 0 }] },
        {},
      )
      .result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("503");
    expect(calls).toHaveBeenCalledOnce();
  });
});

describe("ByokCredentialCoordinatorObject /complete", () => {
  const complete = (body: Record<string, unknown>) =>
    stub()
      .fetch("https://coordinator/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threadId: THREAD,
          ownerUserId: OWNER,
          selection: { kind: "model", model: "openai/gpt-6-astra" },
          systemPrompt: "Title the message.",
          message: "<user_message>\nFix OAuth retries\n</user_message>",
          maxTokens: 2_048,
          ...body,
        }),
      })
      .then(drained);

  const storageKeys = () =>
    runInDurableObject(stub(), async (_instance, state) => [
      ...(await state.storage.list()).keys(),
    ]);

  it("completes on the thread's current route at low effort without pinning or attributing", async () => {
    await seed();
    const before = await storageKeys();
    const calls: {
      authorization: string | null;
      body: Record<string, unknown>;
    }[] = [];
    stubFetch(async (request) => {
      calls.push({
        authorization: request.headers.get("authorization"),
        body: (await request.json()) as Record<string, unknown>,
      });
      return new Response(
        `data: ${JSON.stringify({
          id: "chat-title",
          object: "chat.completion.chunk",
          created: 0,
          model: "astra-litellm",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "OAuth refresh retries" },
              finish_reason: "stop",
            },
          ],
        })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    });

    const response = await complete({});

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      text: "OAuth refresh retries",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.authorization).toBe("Bearer sk-litellm-real");
    expect(calls[0]?.body).toMatchObject({
      model: "astra-litellm",
      messages: [
        { role: "developer", content: "Title the message." },
        {
          role: "user",
          content: "<user_message>\nFix OAuth retries\n</user_message>",
        },
      ],
    });
    expect(calls[0]?.body).not.toHaveProperty("tools");
    expect(calls[0]?.body).toMatchObject({ reasoning_effort: "low" });
    expect(await storageKeys()).toEqual(before);
  });

  it("lets DxTitleAgent settle only a pending title", async () => {
    await seed();
    stubFetch(
      async () =>
        new Response(
          `data: ${JSON.stringify({
            id: "chat-title",
            object: "chat.completion.chunk",
            created: 0,
            model: "astra-litellm",
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: "OAuth refresh retries" },
                finish_reason: "stop",
              },
            ],
          })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const row = () =>
      env.DB.prepare(
        "SELECT title, title_pending_until FROM threads WHERE id = ?",
      )
        .bind(THREAD)
        .first<{ title: string; title_pending_until: string | null }>();
    const job = {
      threadId: THREAD as never,
      ownerUserId: OWNER as never,
      selection: {
        kind: "model" as const,
        model: "openai/gpt-6-astra" as never,
      },
      message: "Fix OAuth callback retries when refresh tokens expire",
      persisted: Promise.resolve(true),
    };

    await runDxTitleAgent(env as never, job);
    expect(await row()).toEqual({
      title: "Untitled thread",
      title_pending_until: null,
    });

    await env.DB.prepare(
      "UPDATE threads SET title_pending_until = ? WHERE id = ?",
    )
      .bind(new Date(Date.now() + 40_000).toISOString(), THREAD)
      .run();
    await runDxTitleAgent(env as never, job);
    expect(await row()).toEqual({
      title: "OAuth refresh retries",
      title_pending_until: null,
    });
  });

  it("asks Workers AI GLM 5.3 Flash for low thinking", async () => {
    await seed();
    const payloads: Record<string, unknown>[] = [];
    const ai = {
      run: vi.fn(async (_model: string, payload: Record<string, unknown>) => {
        payloads.push(payload);
        return new Response(
          `data: ${JSON.stringify({
            choices: [
              {
                index: 0,
                delta: { content: "BUG: iOS paste" },
                finish_reason: "stop",
              },
            ],
          })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    };
    const coordinatorEnv = () =>
      runInDurableObject(
        stub(),
        (instance) =>
          (instance as unknown as { env: Record<string, unknown> }).env,
      );
    (await coordinatorEnv()).AI = ai;
    try {
      const response = await complete({
        selection: {
          kind: "model",
          model: "cloudflare/@cf/zai-org/glm-5.3-flash",
        },
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        text: "BUG: iOS paste",
      });
      expect(ai.run).toHaveBeenCalledOnce();
      expect(ai.run.mock.calls[0]?.[0]).toBe("@cf/zai-org/glm-5.3-flash");
      expect(payloads[0]).toMatchObject({
        reasoning_effort: "low",
        max_completion_tokens: 2_048,
      });
      expect(payloads[0]).not.toHaveProperty("tools");
    } finally {
      delete (await coordinatorEnv()).AI;
    }
  });

  it("reports an upstream failure without retrying", async () => {
    await seed();
    const calls = vi.fn(async () =>
      Response.json({ error: { message: "Unavailable" } }, { status: 503 }),
    );
    stubFetch(calls);

    const response = await complete({});

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      code: "COMPLETION_FAILED",
    });
    expect(calls).toHaveBeenCalledOnce();
  });

  it("routes by the supplied owner before any Thread row exists", async () => {
    await seed();
    const calls = vi.fn(async () => Response.json({}));
    stubFetch(calls);
    expect((await complete({ message: "" })).status).toBe(400);
    expect((await complete({ selection: { kind: "nope" } })).status).toBe(400);

    const response = await complete({
      threadId: "thr_00000000-0000-4000-8000-00000000c0de",
      ownerUserId: "someone-else",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "MODEL_NOT_SERVED: openai/gpt-6-astra",
    });

    // Once the row exists, only its owner may title it.
    const foreign = await complete({ ownerUserId: "someone-else" });
    expect(foreign.status).toBe(403);
    await expect(foreign.json()).resolves.toEqual({
      code: "THREAD_OWNER_MISMATCH",
    });
    expect(calls).not.toHaveBeenCalled();
  });

  it("runs one title completion per Thread, joined only by an identical request", async () => {
    await seed();
    let release: () => void = () => {};
    const upstreamHeld = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls = vi.fn(async () => {
      await upstreamHeld;
      return new Response(
        `data: ${JSON.stringify({
          id: "chat-title",
          object: "chat.completion.chunk",
          created: 0,
          model: "astra-litellm",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "OAuth refresh retries" },
              finish_reason: "stop",
            },
          ],
        })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    stubFetch(calls);

    const first = complete({});
    await vi.waitFor(() => expect(calls).toHaveBeenCalledOnce(), {
      timeout: 10_000,
    });
    // A double-submitted creation joins the in-flight call.
    const duplicate = complete({});
    const otherModel = await complete({
      selection: { kind: "mode", profileId: "default", mode: "low" },
    });
    expect(otherModel.status).toBe(409);
    const second = await complete({
      message: "<user_message>\nFix billing\n</user_message>",
    });
    release();

    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toEqual({
      code: "COMPLETION_IN_FLIGHT",
    });
    for (const response of [await first, await duplicate]) {
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        text: "OAuth refresh retries",
      });
    }
    expect(calls).toHaveBeenCalledOnce();
  });
});
