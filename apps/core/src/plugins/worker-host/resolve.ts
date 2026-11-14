import { Option } from "effect";
import type { Bindings } from "../../http/types.js";
import { activeMemberSql } from "../../settings/members/membership-sql.js";
import { pluginRunsForOwnerSql } from "../../settings/plugins/bundles/overlap.js";
import { ensureDurableJobs } from "../hosts/durable/ensure.js";
import { manifestIconSet } from "../icons/store.js";
import {
  installedPluginTier,
  installTrustColumns,
  installTrustFromRow,
} from "../trust/resolve-tier.js";
import { mapPluginsLimited } from "./concurrency.js";
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
  readonly views: PluginCodeDescription["views"];
  readonly exports: PluginCodeDescription["exports"];
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
  readonly tier_cap: string | null;
  readonly trusted_signature: number | null;
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
): Promise<ReadonlyArray<PluginInstallRecord>> =>
  (await listCodePluginInstallsOwned(db, ownerSql, key)).installs;

const listCodePluginInstallsOwned = async (
  db: D1Database,
  ownerSql: string,
  key: string,
): Promise<{
  readonly installs: ReadonlyArray<PluginInstallRecord>;
  readonly ownerUserId: string | undefined;
}> => {
  const rows = await db
    .prepare(
      `WITH owner AS (${ownerSql})
       SELECT (SELECT id FROM owner) AS owner_id,
              plugin.id, plugin.scope, plugin.target_id, plugin.name,
              version.trusted_by_user_id,
              version.version, version.integrity, version.manifest_json,
              ${installTrustColumns("plugin")}
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
    .all<
      InstallRow & {
        readonly owner_id: string;
        readonly trusted_by_user_id: string | null;
      }
    >();
  const installs: Array<PluginInstallRecord> = [];
  const names = new Set<string>();
  for (const row of rows.results) {
    // The overlap rule already left out one of a workspace and a personal
    // copy; two workspaces installing the same plugin run the first one.
    if (names.has(row.name)) continue;
    let manifest: {
      code?: unknown;
      displayName?: unknown;
      iconSet?: unknown;
      icon?: unknown;
      package?: { sha256?: unknown; size?: unknown };
    };
    try {
      manifest = JSON.parse(row.manifest_json) as typeof manifest;
    } catch {
      continue;
    }
    const code = decodePluginCode(manifest.code);
    if (Option.isNone(code)) continue;
    names.add(row.name);
    const scope = row.scope === "workspace" ? "workspace" : "personal";
    const iconSet = await manifestIconSet(db, manifest);
    installs.push({
      ...(iconSet === undefined ? {} : { iconSet }),
      pluginId: row.id,
      name: row.name,
      displayName:
        typeof manifest.displayName === "string"
          ? manifest.displayName
          : row.name,
      scope,
      targetId: row.target_id,
      version: row.version,
      integrity: row.integrity,
      code: code.value,
      tier: installedPluginTier(
        scope,
        code.value.tier,
        installTrustFromRow(row),
      ),
      ...(row.trusted_by_user_id === null
        ? {}
        : { installedByUserId: row.trusted_by_user_id }),
      ...(typeof manifest.package?.sha256 === "string" &&
      typeof manifest.package.size === "number"
        ? {
            package: {
              sha256: manifest.package.sha256,
              size: manifest.package.size,
            },
          }
        : {}),
    });
    if (installs.length >= MAX_CODE_PLUGINS_PER_THREAD) break;
  }
  return { installs, ownerUserId: rows.results[0]?.owner_id };
};

export const resolveThreadCodePlugins = async (
  bindings: Bindings,
  db: D1Database,
  threadId: string,
  /** Keeps background work alive past the response. */
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<ReadonlyArray<ResolvedCodePlugin>> => {
  const { installs, ownerUserId } = await listCodePluginInstallsOwned(
    db,
    "SELECT owner_user_id AS id FROM threads WHERE id = ?1",
    threadId,
  );
  // ─── Durable host ───
  // Declared jobs start when a Thread first resolves the install: one RPC
  // per isolate, install version, and Thread; no D1 read.
  if (ownerUserId !== undefined) {
    const started = ensureDurableJobs(
      bindings,
      db,
      installs,
      ownerUserId,
      threadId,
    );
    if (started !== undefined) waitUntil?.(started);
  }
  return describeCodePlugins(bindings, db, installs);
};

/** Starts (or reuses) each install's worker and asks what its code handles. */
export const describeCodePlugins = (
  bindings: Bindings,
  db: D1Database,
  installs: ReadonlyArray<PluginInstallRecord>,
): Promise<ReadonlyArray<ResolvedCodePlugin>> =>
  // Under the per-request Dynamic Worker limit: past it, the plugins
  // described last failed to start and dropped out of the Thread.
  mapPluginsLimited(installs, async (install): Promise<ResolvedCodePlugin> => {
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
        views: [],
        exports: [],
        agentModes: [],
        loadError:
          error instanceof Error && error.message !== ""
            ? error.message.slice(0, 500)
            : "Its code did not start.",
      };
    }
  });
