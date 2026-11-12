import { Option } from "effect";
import type { Bindings } from "../../http/types.js";
import { activeMemberSql } from "../../settings/members/membership-sql.js";
import { pluginRunsForOwnerSql } from "../../settings/plugins/bundles/overlap.js";
import type { PluginInstallRecord } from "./host.js";
import {
  decodePluginCode,
  describePlugin,
  logPluginFailure,
  type PluginCodeDescription,
} from "./worker.js";

/**
 * The plugins with code that one submission of a Thread runs: the owner's
 * enabled personal installs and the enabled installs of the workspaces they
 * belong to. When both scopes install the same plugin name, the overlap rule
 * in `settings/plugins/bundles/overlap.ts` picks one copy; the two never run
 * in one Thread. Order is fixed: workspace installs first, then personal,
 * then by name.
 *
 * Each install's worker is started (or reused) and describes its code. A
 * plugin whose code fails to start is kept with `loadError`, so a plugin
 * that gates tool calls still fails closed instead of silently vanishing.
 */

export interface ResolvedCodePlugin extends PluginInstallRecord {
  readonly events: PluginCodeDescription["events"];
  readonly tools: PluginCodeDescription["tools"];
  readonly commands: PluginCodeDescription["commands"];
  readonly linkPatterns: PluginCodeDescription["linkPatterns"];
  readonly panes: PluginCodeDescription["panes"];
  readonly agentModes: PluginCodeDescription["agentModes"];
  readonly loadError?: string;
}

/** At most this many plugins with code run in one Thread. */
export const MAX_CODE_PLUGINS_PER_THREAD = 16;

interface InstallRow {
  readonly id: string;
  readonly scope: string;
  readonly target_id: string;
  readonly name: string;
  readonly version: string;
  readonly integrity: string;
  readonly manifest_json: string;
}

export const listThreadCodePluginInstalls = (
  db: D1Database,
  threadId: string,
): Promise<ReadonlyArray<PluginInstallRecord>> =>
  listCodePluginInstalls(
    db,
    "SELECT owner_user_id AS id FROM threads WHERE id = ?1",
    threadId,
  );

/** The same installs for a person, before they have a Thread. */
export const listOwnerCodePluginInstalls = (
  db: D1Database,
  ownerUserId: string,
): Promise<ReadonlyArray<PluginInstallRecord>> =>
  listCodePluginInstalls(db, "SELECT ?1 AS id", ownerUserId);

const listCodePluginInstalls = async (
  db: D1Database,
  ownerSql: string,
  key: string,
): Promise<ReadonlyArray<PluginInstallRecord>> => {
  const rows = await db
    .prepare(
      `WITH owner AS (${ownerSql})
       SELECT plugin.id, plugin.scope, plugin.target_id, plugin.name,
              version.version, version.integrity, version.manifest_json
         FROM trusted_plugin plugin
         JOIN trusted_plugin_version version
           ON version.plugin_id = plugin.id
          AND version.version = plugin.active_version
        WHERE plugin.kind = 'bundle'
          AND json_type(version.manifest_json, '$.code') = 'object'
          AND ${pluginRunsForOwnerSql("plugin", "(SELECT id FROM owner)")}
          AND (plugin.scope = 'personal'
            OR ${activeMemberSql("plugin.target_id", "(SELECT id FROM owner)")})
        ORDER BY CASE plugin.scope WHEN 'workspace' THEN 0 ELSE 1 END,
                 plugin.name, plugin.id`,
    )
    .bind(key)
    .all<InstallRow>();
  const installs: Array<PluginInstallRecord> = [];
  const names = new Set<string>();
  for (const row of rows.results) {
    // The overlap rule already left out one of a workspace and a personal
    // copy; two workspaces installing the same plugin run the first one.
    if (names.has(row.name)) continue;
    let manifest: { code?: unknown; displayName?: unknown };
    try {
      manifest = JSON.parse(row.manifest_json) as typeof manifest;
    } catch {
      continue;
    }
    const code = decodePluginCode(manifest.code);
    if (Option.isNone(code)) continue;
    names.add(row.name);
    installs.push({
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
    });
    if (installs.length >= MAX_CODE_PLUGINS_PER_THREAD) break;
  }
  return installs;
};

export const resolveThreadCodePlugins = async (
  bindings: Bindings,
  db: D1Database,
  threadId: string,
): Promise<ReadonlyArray<ResolvedCodePlugin>> =>
  describeCodePlugins(
    bindings,
    db,
    await listThreadCodePluginInstalls(db, threadId),
  );

/** Starts (or reuses) each install's worker and asks what its code handles. */
export const describeCodePlugins = (
  bindings: Bindings,
  db: D1Database,
  installs: ReadonlyArray<PluginInstallRecord>,
): Promise<ReadonlyArray<ResolvedCodePlugin>> =>
  Promise.all(
    installs.map(async (install): Promise<ResolvedCodePlugin> => {
      try {
        const description = await describePlugin(bindings, db, install);
        return { ...install, ...description };
      } catch (error) {
        logPluginFailure(install, "start", error);
        return {
          ...install,
          events: install.code.permissions.events,
          tools: [],
          commands: [],
          linkPatterns: [],
          panes: [],
          agentModes: [],
          loadError:
            error instanceof Error && error.message !== ""
              ? error.message.slice(0, 500)
              : "Its code did not start.",
        };
      }
    }),
  );
