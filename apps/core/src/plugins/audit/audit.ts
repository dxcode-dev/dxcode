import { getLogger } from "@logtape/logtape";

/**
 * The plugin audit: one immutable `plugin_audit` row and one log line per
 * capability a plugin's code used, or was refused, on someone's behalf.
 * Every capability writes through `insertPluginAudit`, so one table and one
 * log category answer "what did this plugin do, as whom, and where".
 */

export const pluginAuditLogger = getLogger(["dx", "plugins", "audit"]);

export type PluginAuditOutcome = "success" | "rejected" | "failed";

export interface PluginAuditRow {
  readonly pluginId: string;
  readonly pluginName: string;
  readonly pluginVersion: string;
  readonly scope: "personal" | "workspace" | "repository";
  /** Who the call ran as: the Thread's or the trigger's owner. */
  readonly ownerUserId: string;
  /** The Thread the call ran in; absent for a webhook trigger. */
  readonly threadId?: string;
  /** A dotted name such as `thread.post`, at most 96 characters. */
  readonly action: string;
  /** What the action reached, such as another Thread's id. */
  readonly target?: string;
  readonly outcome: PluginAuditOutcome;
  /** Why, briefly; never message text or secrets. At most 4 KB of JSON. */
  readonly detail?: Readonly<Record<string, unknown>>;
  /** The request the call served, for tying the row to Worker logs. */
  readonly requestId?: string;
  /**
   * The person whose click started the call, when not the owner: a
   * member of a shared Thread. Kept in the row's detail as `actorUserId`,
   * so a member's call is never recorded as the owner's alone.
   */
  readonly actorUserId?: string;
}

const DETAIL_BYTES = 4_096;

/** A row's detail with the acting member, when one started the call. */
export const auditDetail = (
  detail: PluginAuditRow["detail"],
  actorUserId: string | undefined,
): PluginAuditRow["detail"] =>
  actorUserId === undefined ? detail : { ...detail, actorUserId };

const detailJson = (detail: PluginAuditRow["detail"]) => {
  if (detail === undefined) return null;
  const json = JSON.stringify(detail);
  return new TextEncoder().encode(json).byteLength <= DETAIL_BYTES
    ? json
    : JSON.stringify({ truncated: true });
};

/** The statement for one audit row, to batch with the action's own writes. */
export const pluginAuditStatement = (
  db: D1Database,
  row: PluginAuditRow,
  id: string = `pla_${crypto.randomUUID()}`,
  now: Date = new Date(),
) =>
  db
    .prepare(
      `INSERT INTO plugin_audit (
         id, plugin_id, plugin_name, plugin_version, scope, owner_user_id,
         thread_id, action, target, outcome, detail_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      row.pluginId,
      row.pluginName.slice(0, 214),
      row.pluginVersion.slice(0, 160),
      row.scope,
      row.ownerUserId,
      row.threadId ?? null,
      row.action.slice(0, 96),
      row.target?.slice(0, 256) ?? null,
      row.outcome,
      detailJson(auditDetail(row.detail, row.actorUserId)),
      now.toISOString(),
    );

const logAudit = (id: string, row: PluginAuditRow) => {
  const properties = {
    event: "plugin_audit",
    auditId: id,
    pluginId: row.pluginId,
    plugin: row.pluginName,
    version: row.pluginVersion,
    scope: row.scope,
    ownerUserId: row.ownerUserId,
    threadId: row.threadId,
    action: row.action,
    target: row.target,
    outcome: row.outcome,
    requestId: row.requestId,
    ...(row.actorUserId === undefined ? {} : { actorUserId: row.actorUserId }),
    detail: row.detail,
  };
  const text = `Plugin ${row.pluginName} ${row.action} ${row.outcome}`;
  if (row.outcome === "success") pluginAuditLogger.info(text, properties);
  else pluginAuditLogger.warn(text, properties);
};

/**
 * Records one plugin action. A failed audit write is logged, never thrown:
 * the log line still records the action.
 */
export const insertPluginAudit = async (
  db: D1Database,
  row: PluginAuditRow,
): Promise<string> => {
  const id = `pla_${crypto.randomUUID()}`;
  logAudit(id, row);
  try {
    await pluginAuditStatement(db, row, id).run();
  } catch (cause) {
    pluginAuditLogger.error("A plugin audit row was not written.", {
      event: "plugin_audit_write_failed",
      auditId: id,
      pluginId: row.pluginId,
      action: row.action,
      cause,
    });
  }
  return id;
};
