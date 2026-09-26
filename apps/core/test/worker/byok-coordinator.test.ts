import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { createModels } from "@earendil-works/pi-ai";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfigEncryptionKeyring } from "../../src/settings/config-encryption.js";
import { createDxModelRoutingProvider } from "../../src/settings/model-byok/flue-provider.js";
import {
  ByokCredentialCoordinatorObject,
  upstreamDns,
  upstreamFetch,
} from "../../src/settings/model-byok/invocation.js";
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
const MAX_BODY_BYTES = 24 * 1_048_576;

const now = "2026-09-01T00:00:00.000Z";

const b64 = (value: unknown): string =>
  btoa(
    new TextDecoder().decode(new TextEncoder().encode(JSON.stringify(value))),
  );

const seed = async () => {
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
      "sk-litellm-real" as never,
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
    body: b64({ model: "dx-placeholder", messages: [] }),
  },
  ...overrides,
});

// Consume DO bodies so an eviction does not wait on earlier test responses.
const drained = async (response: Response) =>
  new Response(await response.arrayBuffer(), response);

const callProxy = (envelope: Record<string, unknown>) =>
  stub()
    .fetch("https://coordinator/proxy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    })
    .then(drained);

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
            new Request("https://coordinator/proxy", {
              method: "POST",
              body: JSON.stringify(proxyEnvelope()),
            }),
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

  it("rejects oversized bodies without trusting Content-Length", async () => {
    const oversized = JSON.stringify({ payload: "x".repeat(MAX_BODY_BYTES) });
    for (const headers of [
      { "content-type": "application/json" },
      { "content-type": "application/json", "content-length": "1" },
    ]) {
      const response = await stub().fetch("https://coordinator/resolve", {
        method: "POST",
        headers,
        body: oversized,
      });
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ code: "REQUEST_TOO_LARGE" });
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
    const response = await stub().fetch("https://dx-byok.invalid/proxy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(proxyEnvelope()),
    });
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

  it("refuses cross-origin request urls", async () => {
    await seed();
    const response = await callProxy(
      proxyEnvelope({
        request: {
          url: "https://evil.example/chat/completions",
          method: "POST",
          headers: { authorization: "Bearer dx-placeholder" },
          body: b64({ model: "x" }),
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
