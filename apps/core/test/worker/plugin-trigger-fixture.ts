import { env } from "cloudflare:test";

export const pluginTriggerOwner = "plugin-trigger-owner";
const timestamp = "2026-08-23T00:00:00.000Z";

/** The event a code plugin's webhook trigger takes. */
export const PLUGIN_TRIGGER_EVENT = "trigger.received";

const sha256 = async (value: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");

/**
 * A personal install of a plugin whose code handles `trigger.received`,
 * with an active webhook trigger for it. The handler succeeds unless the
 * delivery's data has `fail: true`.
 */
export const setupPluginTrigger = async (
  options: {
    readonly idempotent?: boolean;
    readonly capabilityHash?: string;
    readonly hmacReference?: unknown;
  } = {},
) => {
  const idempotent = options.idempotent ?? true;
  const pluginId = `plg_${crypto.randomUUID()}`;
  const triggerId = `trg_${crypto.randomUUID()}`;
  const name = `com.example.trigger-${crypto.randomUUID().slice(0, 8)}`;
  const entry = "dev.dxcode/index.js";
  const source = `export default (dx) => dx.on("trigger.received", (event) => {
  if (event.data && event.data.fail) throw new Error("The delivery failed.");
});`;
  const moduleIntegrity = await sha256(source);
  const integrity = await sha256(`${name}:${moduleIntegrity}`);
  const version = `1.0.0+${integrity.slice(0, 12)}`;
  const manifest = {
    format: "agent-plugins",
    name,
    displayName: "Webhook receiver",
    description: "Receives a webhook in its Dynamic Worker.",
    version: "1.0.0",
    skills: [],
    mcpServers: [],
    code: {
      apiVersion: 1,
      host: "worker",
      entry,
      modules: [
        {
          path: entry,
          bytes: new TextEncoder().encode(source).byteLength,
          integrity: moduleIntegrity,
        },
      ],
      permissions: {
        events: [PLUGIN_TRIGGER_EVENT],
        network: [],
        secrets: [],
        tools: [],
        ai: false,
      },
      settings: [],
    },
    skipped: [],
  };
  await env.DB.batch([
    env.DB.prepare(
      'INSERT OR IGNORE INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
    ).bind(
      pluginTriggerOwner,
      "Trigger Owner",
      "plugin-trigger@example.com",
      1,
      1,
    ),
    env.DB.prepare(
      `INSERT INTO trusted_plugin (
         id, scope, target_id, name, enabled, active_version, health_status,
         created_at, updated_at, kind
       ) VALUES (?, 'personal', ?, ?, 1, ?, 'unchecked', ?, ?, 'bundle')`,
    ).bind(pluginId, pluginTriggerOwner, name, version, timestamp, timestamp),
    env.DB.prepare(
      `INSERT INTO trusted_plugin_version (
         plugin_id, version, manifest_json, grants_json, source_json,
         integrity, trusted, trusted_at, trusted_by_user_id
       ) VALUES (?, ?, ?, '{}', ?, ?, 1, ?, ?)`,
    ).bind(
      pluginId,
      version,
      JSON.stringify(manifest),
      JSON.stringify({ type: "zip", label: "trigger.zip" }),
      integrity,
      timestamp,
      pluginTriggerOwner,
    ),
    env.DB.prepare(
      `INSERT INTO trusted_plugin_file (
         plugin_id, version, path, media_type, content, size_bytes, integrity
       ) VALUES (?, ?, ?, 'text/javascript', ?, ?, ?)`,
    ).bind(
      pluginId,
      version,
      entry,
      source,
      new TextEncoder().encode(source).byteLength,
      moduleIntegrity,
    ),
    env.DB.prepare(
      `INSERT INTO plugin_trigger (
         id, owner_user_id, plugin_id, plugin_version, capability_name,
         source, event_type, action_name, idempotent, status, capability_hash,
         hmac_reference_json, created_at, updated_at, rotated_at
       ) VALUES (?, ?, ?, ?, 'webhook', 'webhook', ?, 'webhook', ?, 'active',
                 ?, ?, ?, ?, ?)`,
    ).bind(
      triggerId,
      pluginTriggerOwner,
      pluginId,
      version,
      PLUGIN_TRIGGER_EVENT,
      idempotent ? 1 : 0,
      options.capabilityHash ??
        crypto.randomUUID().replaceAll("-", "").repeat(2),
      options.hmacReference === undefined
        ? null
        : JSON.stringify(options.hmacReference),
      timestamp,
      timestamp,
      timestamp,
    ),
  ]);
  const stub = env.PLUGIN_TRIGGER_DELIVERY.get(
    env.PLUGIN_TRIGGER_DELIVERY.idFromName(triggerId),
  );
  return { pluginId, triggerId, stub };
};
