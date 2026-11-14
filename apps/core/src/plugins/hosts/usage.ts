import { USAGE_EVENT_RETENTION_DAYS } from "@dx/domain";
import { getLogger } from "@logtape/logtape";

/**
 * What plugin hosts beyond the Worker cost (decision D4): one row of
 * `plugin_host_usage` per metered span, charged to the workspace that
 * installed the plugin. The container host writes one per call; the Durable
 * Object host one per install about every 15 minutes. Rows are never
 * updated, and expire with the usage retention window.
 */

const logger = getLogger(["dx", "plugins", "hosts", "usage"]);

export interface PluginHostUsage {
  /** `trusted_plugin.id` of the install. */
  readonly pluginId: string;
  readonly pluginName: string;
  readonly scope: "personal" | "workspace" | "repository";
  /**
   * The workspace that pays. A workspace install's own workspace; for a
   * personal install, the installer's membership (resolved in SQL).
   */
  readonly workspaceId?: string;
  readonly ownerUserId: string;
  /**
   * The Thread the usage served, when there is one: a personal install's
   * cost goes to the workspace of that Thread's Project.
   */
  readonly threadId?: string;
  readonly host: "worker" | "durable" | "orb" | "container";
  /** The container instance type; absent for other hosts. */
  readonly instance?: string;
  readonly unitsMs: number;
  readonly requests?: number;
  readonly storageBytes?: number;
  readonly costMicroUsd: number;
  readonly outcome: "success" | "error" | "blocked";
  readonly periodStart: number;
  readonly periodEnd: number;
}

const iso = (ms: number) => new Date(ms).toISOString();

export const recordPluginHostUsage = async (
  db: D1Database,
  usage: PluginHostUsage,
): Promise<void> => {
  const end = iso(Math.max(usage.periodEnd, usage.periodStart));
  await db
    .prepare(
      `INSERT INTO plugin_host_usage (
         id, plugin_id, plugin_name, scope, workspace_id, owner_user_id, host,
         instance, units_ms, requests, storage_bytes, cost_microusd, outcome,
         period_start, period_end, expires_at
       ) VALUES (?1, ?2, ?3, ?4,
         -- Who pays, the same answer every time: the install's workspace;
         -- else the workspace of the Thread's Project; else the owner's
         -- oldest workspace. NULL only for a person in no workspace at all,
         -- whose usage is their own.
         COALESCE(
           ?5,
           (SELECT project.workspace_id FROM threads thread
              JOIN projects project ON project.id = thread.project_id
             WHERE thread.id = ?16),
           (SELECT member.organizationId FROM member
             WHERE member.userId = ?6
             ORDER BY member.createdAt, member.organizationId LIMIT 1)),
         ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
         strftime('%Y-%m-%dT%H:%M:%fZ', ?15, '+${USAGE_EVENT_RETENTION_DAYS} days'))`,
    )
    .bind(
      `phu_${crypto.randomUUID()}`,
      usage.pluginId,
      usage.pluginName,
      usage.scope,
      usage.workspaceId ?? null,
      usage.ownerUserId,
      usage.host,
      usage.instance ?? null,
      Math.max(0, Math.round(usage.unitsMs)),
      Math.max(0, Math.round(usage.requests ?? 0)),
      Math.max(0, Math.round(usage.storageBytes ?? 0)),
      Math.max(0, Math.round(usage.costMicroUsd)),
      usage.outcome,
      iso(usage.periodStart),
      end,
      usage.threadId ?? null,
    )
    .run();
};

/** Metering never fails the call it describes; failures are logged. */
export const recordPluginHostUsageSafely = (
  db: D1Database,
  usage: PluginHostUsage,
) =>
  recordPluginHostUsage(db, usage).catch((error: unknown) => {
    logger.error("Plugin host usage could not be recorded.", {
      event: "plugin_host_usage_record_failed",
      pluginId: usage.pluginId,
      host: usage.host,
      error: error instanceof Error ? error.message : String(error),
    });
  });

/** One plugin's cost line: this calendar month (UTC) so far. */
export interface PluginHostCostLine {
  readonly pluginId: string;
  readonly host: PluginHostUsage["host"];
  readonly unitsMs: number;
  readonly requests: number;
  readonly costMicroUsd: number;
  readonly blocked: number;
}

/**
 * Every plugin's month-to-date host cost for the installs a person sees on
 * the Plugins page: one indexed read when that page loads, never on a call.
 */
export const listPluginHostCostLines = async (
  db: D1Database,
  pluginIds: ReadonlyArray<string>,
  now = Date.now(),
): Promise<ReadonlyArray<PluginHostCostLine>> => {
  if (pluginIds.length === 0) return [];
  const date = new Date(now);
  const monthStart = iso(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1),
  );
  const ids = [...new Set(pluginIds)].slice(0, 90);
  const rows = await db
    .prepare(
      `SELECT plugin_id, host,
              COALESCE(SUM(units_ms), 0) AS units_ms,
              COALESCE(SUM(requests), 0) AS requests,
              COALESCE(SUM(cost_microusd), 0) AS cost_microusd,
              COALESCE(SUM(CASE WHEN outcome = 'blocked' THEN requests ELSE 0 END), 0) AS blocked
         FROM plugin_host_usage
        WHERE plugin_id IN (${ids.map((_, index) => `?${index + 2}`).join(", ")})
          AND period_end >= ?1
        GROUP BY plugin_id, host`,
    )
    .bind(monthStart, ...ids)
    .all<{
      plugin_id: string;
      host: PluginHostUsage["host"];
      units_ms: number;
      requests: number;
      cost_microusd: number;
      blocked: number;
    }>();
  return rows.results.map((row) => ({
    pluginId: row.plugin_id,
    host: row.host,
    unitsMs: row.units_ms,
    requests: row.requests,
    costMicroUsd: row.cost_microusd,
    blocked: row.blocked,
  }));
};

/** Deletes rows past the usage retention window (the daily retention pass). */
export const purgeExpiredPluginHostUsage = (
  db: D1Database,
  before: string,
): Promise<D1Result<unknown>> =>
  db
    .prepare("DELETE FROM plugin_host_usage WHERE expires_at <= ?")
    .bind(before)
    .run();
