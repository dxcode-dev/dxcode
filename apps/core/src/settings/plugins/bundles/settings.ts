import type { PluginBundleSettingData } from "@dx/api";
import type { PluginCodeSetting, StoredPluginBundle } from "@dx/domain";
import { PluginBundleRejected } from "./errors.js";

/**
 * Install-time settings of a plugin's code: the manifest declares them
 * (`extensions["dev.dxcode"].settings`), and the install's owner, or a
 * workspace admin for a workspace install, fills them on the Plugins page.
 * Values live in `plugin_install_setting`, keyed by install; the code reads
 * them with `ctx.settings.get()`, each declared default filled in.
 */

type SettingValue = string | number | boolean;

const ofType = (setting: PluginCodeSetting, value: unknown) =>
  typeof value === (setting.type === "string" ? "string" : setting.type) &&
  (typeof value !== "number" || Number.isFinite(value)) &&
  (typeof value !== "string" || value.length <= 1_024) &&
  // The stored JSON's own limit.
  JSON.stringify(value).length <= 2_048;

export const readPluginSettings = async (
  db: D1Database,
  bundle: StoredPluginBundle,
): Promise<ReadonlyArray<PluginBundleSettingData>> => {
  const declared = bundle.manifest.code?.settings ?? [];
  if (declared.length === 0) return [];
  const rows = await db
    .prepare(
      "SELECT key, value_json FROM plugin_install_setting WHERE plugin_id = ?",
    )
    .bind(bundle.id)
    .all<{ key: string; value_json: string }>();
  const stored = new Map(
    rows.results.map(({ key, value_json }) => [
      key,
      JSON.parse(value_json) as unknown,
    ]),
  );
  return declared.map((setting) => {
    const value = stored.get(setting.key);
    return {
      key: setting.key,
      label: setting.label,
      type: setting.type,
      required: setting.required,
      ...(setting.default === undefined ? {} : { default: setting.default }),
      ...(value !== undefined && ofType(setting, value)
        ? { value: value as SettingValue }
        : {}),
    };
  });
};

/**
 * Saves the given values; null clears one back to its default. Every key
 * must be declared and every value of its type, and a required setting
 * with no default cannot be cleared.
 */
export const writePluginSettings = async (
  db: D1Database,
  bundle: StoredPluginBundle,
  values: Readonly<Record<string, SettingValue | null>>,
  userId: string,
) => {
  const declared = new Map(
    (bundle.manifest.code?.settings ?? []).map((setting) => [
      setting.key,
      setting,
    ]),
  );
  const statements: Array<D1PreparedStatement> = [];
  const now = new Date().toISOString();
  for (const [key, value] of Object.entries(values)) {
    const setting = declared.get(key);
    if (setting === undefined)
      throw new PluginBundleRejected({
        reason: `The plugin has no setting named ${key.slice(0, 64)}.`,
      });
    if (value === null) {
      if (setting.required && setting.default === undefined)
        throw new PluginBundleRejected({
          reason: `${setting.label} is required.`,
        });
      statements.push(
        db
          .prepare(
            "DELETE FROM plugin_install_setting WHERE plugin_id = ? AND key = ?",
          )
          .bind(bundle.id, key),
      );
      continue;
    }
    if (!ofType(setting, value))
      throw new PluginBundleRejected({
        reason: `${setting.label} must be ${
          setting.type === "string"
            ? "text of at most 1,024 characters"
            : `a ${setting.type}`
        }.`,
      });
    statements.push(
      db
        .prepare(
          `INSERT INTO plugin_install_setting
             (plugin_id, key, value_json, updated_at, updated_by_user_id)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (plugin_id, key) DO UPDATE
             SET value_json = excluded.value_json,
                 updated_at = excluded.updated_at,
                 updated_by_user_id = excluded.updated_by_user_id`,
        )
        .bind(bundle.id, key, JSON.stringify(value), now, userId),
    );
  }
  if (statements.length > 0) await db.batch(statements);
};
