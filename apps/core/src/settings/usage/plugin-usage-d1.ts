import {
  type NormalizedUsageQuery,
  type NormalizedWorkspaceUsageQuery,
  PluginScope,
  type PluginUsageAggregate,
  type PluginUsageUserAggregate,
  UserId,
  type WorkspaceId,
} from "@dx/domain";
import { Effect, Schema } from "effect";
import { findPlugin, findProvider } from "../../plugins/registry.js";

/**
 * Read side of `plugin_usage_event` for the Usage pages. Rows group by plugin,
 * provider, capability, credential scope, and unit; units of different kinds
 * are never summed together. Model filters (provider, model) do not apply to
 * plugin calls; attribution filters (owner, Project, Thread) and the range do.
 */

interface WhereClause {
  readonly sql: string;
  readonly values: ReadonlyArray<unknown>;
}

const where = (
  base: ReadonlyArray<readonly [string, unknown]>,
  optional: ReadonlyArray<readonly [string, unknown]>,
): WhereClause => {
  const parts = [
    ...base,
    ...optional.filter(([, value]) => value !== undefined),
  ];
  return {
    sql: parts.map(([clause]) => clause).join(" AND "),
    values: parts.map(([, value]) => value),
  };
};

export const personalPluginUsageWhere = (
  ownerUserId: UserId,
  query: NormalizedUsageQuery,
) =>
  where(
    [
      ["event.owner_user_id = ?", ownerUserId],
      ["event.occurred_at >= ?", query.fromInclusive],
      ["event.occurred_at < ?", query.toExclusive],
    ],
    [
      ["event.project_id = ?", query.projectId],
      ["event.thread_id = ?", query.threadId],
    ],
  );

export const workspacePluginUsageWhere = (
  workspaceId: WorkspaceId,
  query: NormalizedWorkspaceUsageQuery,
) =>
  where(
    [
      ["event.workspace_id = ?", workspaceId],
      ["event.occurred_at >= ?", query.fromInclusive],
      ["event.occurred_at < ?", query.toExclusive],
    ],
    [
      ["event.owner_user_id = ?", query.userId],
      ["event.project_id = ?", query.projectId],
    ],
  );

const groupColumns = `event.plugin_id, event.provider_id, event.capability,
  event.credential_scope, event.unit`;

const aggregateColumns = `
  ${groupColumns},
  COALESCE(SUM(event.units), 0) AS units,
  COUNT(*) AS events,
  COALESCE(SUM(CASE WHEN event.outcome = 'success' THEN 1 ELSE 0 END), 0) AS success_events,
  COALESCE(SUM(CASE WHEN event.outcome = 'error' THEN 1 ELSE 0 END), 0) AS error_events`;

const order = `event.plugin_id, event.provider_id, event.capability,
  CASE event.credential_scope
    WHEN 'personal' THEN 0 WHEN 'workspace' THEN 1 ELSE 2 END,
  event.unit`;

export const pluginUsageStatement = (db: D1Database, clause: WhereClause) =>
  db
    .prepare(
      `SELECT ${aggregateColumns}
       FROM plugin_usage_event AS event
       WHERE ${clause.sql}
       GROUP BY ${groupColumns}
       ORDER BY ${order}`,
    )
    .bind(...clause.values);

export const pluginUsageUsersStatement = (
  db: D1Database,
  clause: WhereClause,
) =>
  db
    .prepare(
      `SELECT
         event.owner_user_id AS user_id,
         COALESCE(personal_account.display_name, user.name) AS user_name,
         ${aggregateColumns}
       FROM plugin_usage_event AS event
       INNER JOIN user ON user.id = event.owner_user_id
       LEFT JOIN personal_account ON personal_account.user_id = event.owner_user_id
       WHERE ${clause.sql}
       GROUP BY event.owner_user_id, ${groupColumns}
       ORDER BY user_name, event.owner_user_id, ${order}`,
    )
    .bind(...clause.values);

const PluginUsageRow = Schema.Struct({
  plugin_id: Schema.String,
  provider_id: Schema.String,
  capability: Schema.String,
  credential_scope: PluginScope,
  unit: Schema.String,
  units: Schema.Number,
  events: Schema.Number,
  success_events: Schema.Number,
  error_events: Schema.Number,
});

const PluginUsageUserRow = Schema.Struct({
  user_id: UserId,
  user_name: Schema.String,
  ...PluginUsageRow.fields,
});

/** Catalog names when the plugin is still registered; the ledger ID otherwise. */
const names = (pluginId: string, providerId: string) => {
  const plugin = findPlugin(pluginId);
  const provider =
    plugin === undefined ? undefined : findProvider(plugin, providerId);
  return {
    pluginName: plugin?.displayName ?? pluginId,
    providerName:
      provider?.displayName ??
      (providerId === "fixture" ? "Local fixture" : providerId),
  };
};

const aggregateFrom = (
  row: typeof PluginUsageRow.Type,
): PluginUsageAggregate => ({
  pluginId: row.plugin_id,
  providerId: row.provider_id,
  ...names(row.plugin_id, row.provider_id),
  capability: row.capability,
  credentialScope: row.credential_scope,
  unit: row.unit,
  units: row.units,
  events: row.events,
  outcomes: { success: row.success_events, error: row.error_events },
});

export const decodePluginUsage = (rows: ReadonlyArray<unknown>) =>
  Schema.decodeUnknownEffect(Schema.Array(PluginUsageRow))(rows).pipe(
    Effect.map(
      (decoded): ReadonlyArray<PluginUsageAggregate> =>
        decoded.map(aggregateFrom),
    ),
  );

export const decodePluginUsageUsers = (rows: ReadonlyArray<unknown>) =>
  Schema.decodeUnknownEffect(Schema.Array(PluginUsageUserRow))(rows).pipe(
    Effect.map(
      (decoded): ReadonlyArray<PluginUsageUserAggregate> =>
        decoded.map((row) => ({
          userId: row.user_id,
          userName: row.user_name,
          ...aggregateFrom(row),
        })),
    ),
  );
