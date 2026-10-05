import type { PluginEnablement } from "@dx/domain";
import { Effect } from "effect";
import {
  type ConfigEncryptionKeyring,
  type ConfigValueEnvelope,
  decryptConfigValue,
  encryptConfigValue,
} from "../settings/config-encryption.js";
import type { ConfigurableProviderId } from "./registry.js";

export type StoredSettingScope = "personal" | "workspace";

export interface StoredPluginConfiguration {
  readonly providerId: ConfigurableProviderId;
  readonly envelope: ConfigValueEnvelope;
  readonly configuredAt: string;
}

export interface StoredPluginSetting {
  readonly scope: StoredSettingScope;
  readonly targetId: string;
  readonly pluginId: string;
  readonly enablement: PluginEnablement | null;
  readonly configuration: StoredPluginConfiguration | null;
  readonly updatedAt: string;
}

interface Row {
  readonly scope: StoredSettingScope;
  readonly target_id: string;
  readonly plugin_id: string;
  readonly enablement: PluginEnablement | null;
  readonly provider_id: ConfigurableProviderId | null;
  readonly key_version: number | null;
  readonly value_nonce: string | null;
  readonly ciphertext: string | null;
  readonly wrapped_key_nonce: string | null;
  readonly wrapped_key: string | null;
  readonly configured_at: string | null;
  readonly updated_at: string;
}

const fromRow = (row: Row): StoredPluginSetting => ({
  scope: row.scope,
  targetId: row.target_id,
  pluginId: row.plugin_id,
  enablement: row.enablement,
  configuration:
    row.provider_id === null ||
    row.key_version === null ||
    row.value_nonce === null ||
    row.ciphertext === null ||
    row.wrapped_key_nonce === null ||
    row.wrapped_key === null ||
    row.configured_at === null
      ? null
      : {
          providerId: row.provider_id,
          configuredAt: row.configured_at,
          envelope: {
            version: 1,
            keyVersion: row.key_version,
            valueNonce: row.value_nonce,
            ciphertext: row.ciphertext,
            wrappedKeyNonce: row.wrapped_key_nonce,
            wrappedKey: row.wrapped_key,
          },
        },
  updatedAt: row.updated_at,
});

/** One scope's setting for one plugin. */
export const findPluginSetting = async (
  db: D1Database,
  scope: StoredSettingScope,
  targetId: string,
  pluginId: string,
): Promise<StoredPluginSetting | undefined> => {
  const row = await db
    .prepare(
      `SELECT * FROM plugin_setting
       WHERE scope = ? AND target_id = ? AND plugin_id = ?`,
    )
    .bind(scope, targetId, pluginId)
    .first<Row>();
  return row === null ? undefined : fromRow(row);
};

/** Personal settings for the user plus their workspace's settings, if any. */
export const listPluginSettings = async (
  db: D1Database,
  userId: string,
  workspaceId: string | undefined,
): Promise<ReadonlyArray<StoredPluginSetting>> => {
  const result = await db
    .prepare(
      `SELECT * FROM plugin_setting
       WHERE (scope = 'personal' AND target_id = ?)
          OR (scope = 'workspace' AND target_id = ?)`,
    )
    .bind(userId, workspaceId ?? "")
    .all<Row>();
  return result.results.map(fromRow);
};

export const putPluginEnablement = (
  db: D1Database,
  scope: StoredSettingScope,
  targetId: string,
  pluginId: string,
  enablement: PluginEnablement | null,
  now: string,
) =>
  db
    .prepare(
      `INSERT INTO plugin_setting (scope, target_id, plugin_id, enablement, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (scope, target_id, plugin_id) DO UPDATE SET
         enablement = excluded.enablement,
         updated_at = excluded.updated_at`,
    )
    .bind(scope, targetId, pluginId, enablement, now)
    .run();

export const putPluginConfiguration = (
  db: D1Database,
  scope: StoredSettingScope,
  targetId: string,
  pluginId: string,
  configuration: StoredPluginConfiguration,
) =>
  pluginConfigurationStatement(
    db,
    scope,
    targetId,
    pluginId,
    configuration,
  ).run();

/** The upsert behind putPluginConfiguration, for a caller's D1 batch. */
export const pluginConfigurationStatement = (
  db: D1Database,
  scope: StoredSettingScope,
  targetId: string,
  pluginId: string,
  configuration: StoredPluginConfiguration,
) =>
  db
    .prepare(
      `INSERT INTO plugin_setting (
         scope, target_id, plugin_id, provider_id, envelope_version, key_version,
         value_nonce, ciphertext, wrapped_key_nonce, wrapped_key, configured_at,
         updated_at
       ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (scope, target_id, plugin_id) DO UPDATE SET
         provider_id = excluded.provider_id,
         envelope_version = 1,
         key_version = excluded.key_version,
         value_nonce = excluded.value_nonce,
         ciphertext = excluded.ciphertext,
         wrapped_key_nonce = excluded.wrapped_key_nonce,
         wrapped_key = excluded.wrapped_key,
         configured_at = excluded.configured_at,
         updated_at = excluded.updated_at`,
    )
    .bind(
      scope,
      targetId,
      pluginId,
      configuration.providerId,
      configuration.envelope.keyVersion,
      configuration.envelope.valueNonce,
      configuration.envelope.ciphertext,
      configuration.envelope.wrappedKeyNonce,
      configuration.envelope.wrappedKey,
      configuration.configuredAt,
      configuration.configuredAt,
    );

export const deletePluginConfiguration = (
  db: D1Database,
  scope: StoredSettingScope,
  targetId: string,
  pluginId: string,
  now: string,
) =>
  deletePluginConfigurationStatement(db, scope, targetId, pluginId, now).run();

export const deletePluginConfigurationStatement = (
  db: D1Database,
  scope: StoredSettingScope,
  targetId: string,
  pluginId: string,
  now: string,
) =>
  db
    .prepare(
      `UPDATE plugin_setting SET
         provider_id = NULL, envelope_version = NULL, key_version = NULL,
         value_nonce = NULL, ciphertext = NULL, wrapped_key_nonce = NULL,
         wrapped_key = NULL, configured_at = NULL, updated_at = ?
       WHERE scope = ? AND target_id = ? AND plugin_id = ?`,
    )
    .bind(now, scope, targetId, pluginId);

/**
 * Plugin credentials share the configuration-vault envelope with
 * environment variables and model credentials, but bind a distinct
 * `plugin-credential` kind plus scope, target, plugin, and provider, so an
 * envelope can never be replayed elsewhere.
 */
const additionalData = (
  setting: Pick<StoredPluginSetting, "scope" | "targetId" | "pluginId">,
  providerId: ConfigurableProviderId,
) => ({
  kind: "plugin-credential",
  scope: setting.scope,
  targetId: setting.targetId,
  pluginId: setting.pluginId,
  providerId,
});

export const encryptPluginCredential = (
  keyring: ConfigEncryptionKeyring,
  setting: Pick<StoredPluginSetting, "scope" | "targetId" | "pluginId">,
  providerId: ConfigurableProviderId,
  credential: string,
) =>
  Effect.runPromise(
    encryptConfigValue(
      keyring,
      additionalData(setting, providerId),
      credential,
    ),
  );

export const decryptPluginCredential = (
  keyring: ConfigEncryptionKeyring,
  setting: StoredPluginSetting & {
    readonly configuration: StoredPluginConfiguration;
  },
) =>
  Effect.runPromise(
    decryptConfigValue(
      keyring,
      additionalData(setting, setting.configuration.providerId),
      setting.configuration.envelope,
    ),
  );
