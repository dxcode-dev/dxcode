import type { PluginBundleCode } from "@dx/domain";
import { Option } from "effect";
import { pluginRunsForOwnerSql } from "../../settings/plugins/bundles/overlap.js";
import { decodePluginCode } from "../worker-host/worker.js";

/**
 * An install as the scheduler, the listener host, and the service host need
 * it: who installed it, its active version, and its package (the plugin's
 * files, which dxd copies onto the plugin Orb when it has a service).
 */
export interface ServiceInstall {
  readonly pluginId: string;
  readonly name: string;
  readonly displayName: string;
  readonly scope: "personal" | "workspace";
  /** The person (personal) or the workspace (workspace). */
  readonly targetId: string;
  readonly version: string;
  readonly integrity: string;
  readonly code: PluginBundleCode;
  readonly installedByUserId: string | undefined;
  readonly package:
    | { readonly sha256: string; readonly size: number }
    | undefined;
}

interface InstallRow {
  readonly id: string;
  readonly scope: string;
  readonly target_id: string;
  readonly name: string;
  readonly version: string;
  readonly integrity: string;
  readonly manifest_json: string;
  readonly trusted_by_user_id: string | null;
}

const installColumns = `plugin.id, plugin.scope, plugin.target_id, plugin.name,
  version.version, version.integrity, version.manifest_json,
  version.trusted_by_user_id`;

const fromRow = (
  row: InstallRow,
  needsService = true,
): ServiceInstall | undefined => {
  let manifest: {
    code?: unknown;
    displayName?: unknown;
    package?: { sha256?: unknown; size?: unknown };
  };
  try {
    manifest = JSON.parse(row.manifest_json) as typeof manifest;
  } catch {
    return undefined;
  }
  const code = decodePluginCode(manifest.code, row);
  if (Option.isNone(code) || (needsService && code.value.service === undefined))
    return undefined;
  return {
    pluginId: row.id,
    name: row.name,
    displayName:
      typeof manifest.displayName === "string"
        ? manifest.displayName
        : row.name,
    scope: row.scope === "workspace" ? "workspace" : "personal",
    targetId: row.target_id,
    version: row.version,
    integrity: row.integrity,
    code: code.value,
    installedByUserId: row.trusted_by_user_id ?? undefined,
    package:
      typeof manifest.package?.sha256 === "string" &&
      typeof manifest.package.size === "number"
        ? { sha256: manifest.package.sha256, size: manifest.package.size }
        : undefined,
  };
};

/**
 * The SQL predicate for an install whose service may run now: enabled, not
 * removed, and, for a personal copy, not paused by its workspace's copy; a
 * workspace's `disabled` wins. A workspace install runs while the member
 * who installed it still belongs to it.
 */
const runsSql = `${pluginRunsForOwnerSql(
  "plugin",
  "CASE WHEN plugin.scope = 'personal' THEN plugin.target_id ELSE version.trusted_by_user_id END",
)}`;

/** One install with a service that may run now, or undefined. */
export const loadServiceInstall = async (
  db: D1Database,
  pluginId: string,
): Promise<ServiceInstall | undefined> => {
  const row = await db
    .prepare(
      `SELECT ${installColumns}
         FROM trusted_plugin AS plugin
         JOIN trusted_plugin_version AS version
           ON version.plugin_id = plugin.id
          AND version.version = plugin.active_version
        WHERE plugin.id = ? AND plugin.kind = 'bundle'
          AND json_type(version.manifest_json, '$.code.service') = 'object'
          AND ${runsSql}`,
    )
    .bind(pluginId)
    .first<InstallRow>();
  return row === null ? undefined : fromRow(row);
};

/**
 * One install with code that may run now, with or without a service: what
 * a schedule or a listener runs for.
 */
export const loadRunningInstall = async (
  db: D1Database,
  pluginId: string,
): Promise<ServiceInstall | undefined> => {
  const row = await db
    .prepare(
      `SELECT ${installColumns}
         FROM trusted_plugin AS plugin
         JOIN trusted_plugin_version AS version
           ON version.plugin_id = plugin.id
          AND version.version = plugin.active_version
        WHERE plugin.id = ? AND plugin.kind = 'bundle'
          AND json_type(version.manifest_json, '$.code') = 'object'
          AND ${runsSql}`,
    )
    .bind(pluginId)
    .first<InstallRow>();
  return row === null ? undefined : fromRow(row, false);
};

/** The person an install acts as: its owner, or a workspace's installer. */
export const actingUserOf = (install: ServiceInstall) =>
  install.scope === "personal" ? install.targetId : install.installedByUserId;

/** Every install with a service that runs on plugin Orb `orbId`. */
export const loadOrbServiceInstalls = async (
  db: D1Database,
  orbId: string,
): Promise<ReadonlyArray<ServiceInstall>> => {
  const { results } = await db
    .prepare(
      `SELECT ${installColumns}
         FROM plugin_service AS service
         JOIN trusted_plugin AS plugin ON plugin.id = service.plugin_id
         JOIN trusted_plugin_version AS version
           ON version.plugin_id = plugin.id
          AND version.version = plugin.active_version
        WHERE service.orb_id = ? AND plugin.kind = 'bundle'
          AND json_type(version.manifest_json, '$.code.service') = 'object'
          AND ${runsSql}`,
    )
    .bind(orbId)
    .all<InstallRow>();
  return results.flatMap((row) => {
    const install = fromRow(row);
    return install === undefined ? [] : [install];
  });
};
