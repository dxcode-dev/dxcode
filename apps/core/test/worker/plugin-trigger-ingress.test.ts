import { env } from "cloudflare:test";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import app from "../../src/app.js";
import type { Bindings } from "../../src/http/types.js";
import {
  encryptEnvironmentVariable,
  loadConfigEncryptionKeyring,
} from "../../src/settings/environment-variables/encryption.js";
import {
  generatePluginTriggerCapability,
  hashPluginTriggerCapability,
} from "../../src/settings/triggers/service.js";
import {
  pluginTriggerOwner,
  setupPluginTrigger,
} from "./plugin-trigger-fixture.js";

const encryptionKeys =
  '{"activeVersion":1,"keys":{"1":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}}';

const bindings: Bindings = {
  DB: env.DB,
  PLUGIN_TRIGGER_DELIVERY: env.PLUGIN_TRIGGER_DELIVERY,
  DX_CONFIG_ENCRYPTION_KEYS: encryptionKeys,
};

const signedHeaders = (overrides: Record<string, string> = {}) => ({
  "content-type": "application/json",
  "x-dx-timestamp": String(Date.now()),
  "x-dx-event-id": `event-${crypto.randomUUID()}`,
  "x-dx-idempotency-key": `intent-${crypto.randomUUID()}`,
  ...overrides,
});

const ingress = (
  triggerId: string,
  capability: string,
  body: string,
  headers: Record<string, string>,
) =>
  app.request(
    `/api/triggers/${triggerId}/${capability}`,
    { method: "POST", headers, body },
    bindings,
  );

const fixture = async (hmacReference?: unknown) => {
  const capability = generatePluginTriggerCapability();
  const capabilityHash = await Effect.runPromise(
    hashPluginTriggerCapability(capability),
  );
  return {
    capability,
    ...(await setupPluginTrigger({ capabilityHash, hmacReference })),
  };
};

const hmac = async (secret: string, input: string) => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input)),
  );
  return `sha256=${Array.from(signature, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
};

describe("plugin trigger webhook ingress", () => {
  it("authenticates the capability and deduplicates accepted events", async () => {
    const { triggerId, capability } = await fixture();
    const body = JSON.stringify({
      event: "build.completed",
      data: { build: 49 },
    });
    const headers = signedHeaders();
    const accepted = await ingress(triggerId, capability, body, headers);
    expect(accepted.status).toBe(202);
    const first = await accepted.json<{ data: { deliveryId: string } }>();
    expect(first.data.deliveryId).toMatch(/^tdl_/);

    const duplicate = await ingress(triggerId, capability, body, headers);
    expect(duplicate.status).toBe(200);
    await expect(duplicate.json()).resolves.toMatchObject({
      data: { deliveryId: first.data.deliveryId, duplicate: true },
    });

    const stored = await env.DB.prepare(
      "SELECT capability_hash, hmac_reference_json FROM plugin_trigger WHERE id = ?",
    )
      .bind(triggerId)
      .first<{ capability_hash: string; hmac_reference_json: string | null }>();
    expect(stored?.capability_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(capability);
    await env.DB.prepare(
      `INSERT INTO plugin_trigger_audit (
         audit_id, trigger_id, owner_user_id, action, outcome, request_id,
         created_at
       ) VALUES (?, ?, ?, 'plugin_trigger.test', 'success', ?, ?)`,
    )
      .bind(
        `taud_${crypto.randomUUID()}`,
        triggerId,
        pluginTriggerOwner,
        "secret-free-audit-test",
        "2026-08-23T00:00:00.000Z",
      )
      .run();
    await expect(
      env.DB.prepare(
        "UPDATE plugin_trigger_audit SET action = 'tampered' WHERE request_id = ?",
      )
        .bind("secret-free-audit-test")
        .run(),
    ).rejects.toBeDefined();
    const audit = await env.DB.prepare(
      "SELECT * FROM plugin_trigger_audit WHERE request_id = ?",
    )
      .bind("secret-free-audit-test")
      .first();
    expect(JSON.stringify(audit)).not.toContain(capability);
  });

  it("rejects wrong tokens, stale timestamps, invalid events, media, and size", async () => {
    const { triggerId, capability } = await fixture();
    const body = JSON.stringify({ event: "build.completed", data: {} });
    expect(
      (
        await ingress(
          triggerId,
          generatePluginTriggerCapability(),
          body,
          signedHeaders(),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await ingress(
          triggerId,
          capability,
          body,
          signedHeaders({
            "x-dx-timestamp": String(Date.now() - 6 * 60 * 1_000),
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await ingress(
          triggerId,
          capability,
          JSON.stringify({ event: "build.started", data: {} }),
          signedHeaders(),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await ingress(triggerId, capability, body, {
          ...signedHeaders(),
          "content-type": "text/plain",
        })
      ).status,
    ).toBe(415);
    expect(
      (
        await ingress(
          triggerId,
          capability,
          JSON.stringify({
            event: "build.completed",
            data: "x".repeat(65_536),
          }),
          signedHeaders(),
        )
      ).status,
    ).toBe(413);
  });

  it("verifies HMAC over the exact timestamp, identities, and body bytes", async () => {
    const variableId = `env_${crypto.randomUUID()}`;
    const reference = {
      version: 1 as const,
      kind: "environment-variable" as const,
      id: variableId,
    };
    const { triggerId, capability } = await fixture(reference);
    const secret = "synthetic-hmac-secret";
    const context = {
      id: variableId,
      target: { scope: "personal", id: pluginTriggerOwner },
      name: "WEBHOOK_HMAC",
      kind: "secret",
    } as never;
    const keyring = await Effect.runPromise(
      loadConfigEncryptionKeyring(bindings),
    );
    const envelope = await Effect.runPromise(
      encryptEnvironmentVariable(keyring, context, secret as never),
    );
    await env.DB.prepare(
      `INSERT INTO environment_variable (
         id, scope, target_id, name, kind, enabled, policy_locked,
         envelope_version, key_version, value_nonce, ciphertext,
         wrapped_key_nonce, wrapped_key, created_at, updated_at, rotated_at
       ) VALUES (?, 'personal', ?, 'WEBHOOK_HMAC', 'secret', 1, 0,
                 ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        variableId,
        pluginTriggerOwner,
        envelope.version,
        envelope.keyVersion,
        envelope.valueNonce,
        envelope.ciphertext,
        envelope.wrappedKeyNonce,
        envelope.wrappedKey,
        "2026-08-23T00:00:00.000Z",
        "2026-08-23T00:00:00.000Z",
        "2026-08-23T00:00:00.000Z",
      )
      .run();
    const body = JSON.stringify({
      event: "build.completed",
      data: { exact: true },
    });
    const timestamp = String(Date.now());
    const eventId = "github:delivery-49";
    const idempotencyKey = "build:49";
    const signature = await hmac(
      secret,
      `${timestamp}.${eventId}.${idempotencyKey}.${body}`,
    );
    const headers = signedHeaders({
      "x-dx-timestamp": timestamp,
      "x-dx-event-id": eventId,
      "x-dx-idempotency-key": idempotencyKey,
      "x-dx-signature": signature,
    });
    expect((await ingress(triggerId, capability, body, headers)).status).toBe(
      202,
    );
    expect(
      (
        await ingress(triggerId, capability, `${body} `, {
          ...headers,
          "x-dx-event-id": "github:delivery-tampered",
        })
      ).status,
    ).toBe(403);
  });

  it("blocks ingress when the trusted plugin is disabled", async () => {
    const { pluginId, triggerId, capability } = await fixture();
    await env.DB.prepare("UPDATE trusted_plugin SET enabled = 0 WHERE id = ?")
      .bind(pluginId)
      .run();
    expect(
      (
        await ingress(
          triggerId,
          capability,
          JSON.stringify({ event: "build.completed", data: {} }),
          signedHeaders(),
        )
      ).status,
    ).toBe(403);
  });
});
