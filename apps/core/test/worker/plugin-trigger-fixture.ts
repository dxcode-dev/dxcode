import { env } from "cloudflare:test";
import { pluginPermissionsEmpty } from "@dx/domain";
import { Effect } from "effect";
import { previewPluginImport } from "../../src/settings/plugins/import.js";

export const pluginTriggerOwner = "plugin-trigger-owner";
const timestamp = "2026-08-23T00:00:00.000Z";

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
  const manifest = {
    schemaVersion: 1,
    name: `trigger-${crypto.randomUUID().slice(0, 8)}`,
    displayName: "Webhook receiver",
    description: "Receives an authenticated webhook in the isolated runtime.",
    version: "1.0.0",
    entrypoint: "main.mjs",
    tools: [],
    commands: [],
    lifecycle: [],
    triggers: [
      {
        name: "receive-event",
        description: "Receive the bounded webhook event.",
        source: "webhook",
        event: "build.completed",
        action: "receive-event",
        idempotent,
      },
    ],
    uiSurfaces: [],
    permissions: {
      tools: [],
      commands: [],
      lifecycle: [],
      triggers: ["receive-event"],
      uiSurfaces: [],
      networkDestinations: [],
      secretNames: [],
      filesystem: [],
      mcpServerIds: [],
      agentCapabilities: [],
    },
  };
  const preview = await Effect.runPromise(
    previewPluginImport({
      source: { type: "browser-files", label: "Trigger fixture" },
      files: [
        {
          path: "plugin.json",
          kind: "file",
          mediaType: "application/json",
          encoding: "utf-8",
          content: JSON.stringify(manifest),
        },
        {
          path: "main.mjs",
          kind: "file",
          mediaType: "text/javascript",
          encoding: "utf-8",
          content:
            "export const triggers = { 'receive-event': async ({ input }) => input };",
        },
      ],
    }),
  );
  const grants = {
    ...pluginPermissionsEmpty(),
    triggers: ["receive-event"],
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
         created_at, updated_at
       ) VALUES (?, 'personal', ?, ?, 1, '1.0.0', 'unchecked', ?, ?)`,
    ).bind(pluginId, pluginTriggerOwner, manifest.name, timestamp, timestamp),
    env.DB.prepare(
      `INSERT INTO trusted_plugin_version (
         plugin_id, version, manifest_json, grants_json, source_json,
         integrity, trusted, trusted_at, trusted_by_user_id
       ) VALUES (?, '1.0.0', ?, ?, ?, ?, 1, ?, ?)`,
    ).bind(
      pluginId,
      JSON.stringify(preview.manifest),
      JSON.stringify(grants),
      JSON.stringify(preview.source),
      preview.integrity,
      timestamp,
      pluginTriggerOwner,
    ),
    ...preview.files.map((file) =>
      env.DB.prepare(
        `INSERT INTO trusted_plugin_file (
           plugin_id, version, path, media_type, content, size_bytes, integrity
         ) VALUES (?, '1.0.0', ?, ?, ?, ?, ?)`,
      ).bind(
        pluginId,
        file.path,
        file.mediaType,
        file.content,
        file.sizeBytes,
        file.integrity,
      ),
    ),
    env.DB.prepare(
      `INSERT INTO plugin_trigger (
         id, owner_user_id, plugin_id, plugin_version, capability_name,
         source, event_type, action_name, idempotent, status, capability_hash,
         hmac_reference_json, created_at, updated_at, rotated_at
       ) VALUES (?, ?, ?, '1.0.0', 'receive-event', 'webhook',
                 'build.completed', 'receive-event', ?, 'active', ?, ?, ?, ?, ?)`,
    ).bind(
      triggerId,
      pluginTriggerOwner,
      pluginId,
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
