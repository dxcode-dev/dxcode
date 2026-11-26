import { ThreadId } from "@dx/domain";
import { Option, Schema } from "effect";
import { activeMemberSql } from "../../settings/members/membership-sql.js";

/**
 * Who owns an Orb: a Thread, or a plugin Orb (wiki/plugin-platform-direction.md
 * "Plugin services").
 *
 * A plugin Orb's ID has the Thread ID format, so the execution stack keeps
 * addressing every Orb by one string (provider handles, dxd's key, the
 * execution object, idle sleep, meters). It is never a Thread: no threads
 * row has it, so every Thread route and listing refuses or skips it. Code
 * that starts, keeps, or stops an Orb asks {@link resolveExecutionOwner};
 * Thread-only code keeps taking `ThreadId` and reading `threads`.
 *
 * A plugin Orb's ID crosses into the execution stack only through
 * {@link pluginOrbExecutionKey}, never by accident.
 */

const PluginOrbIdBrand: unique symbol = Symbol.for("@dx/PluginOrbId");

/** A plugin Orb's ID; not a Thread ID even though it is shaped like one. */
export type PluginOrbId = string & { readonly [PluginOrbIdBrand]: true };

export const isPluginOrbIdShape = (value: string): value is PluginOrbId =>
  /^thr_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    value,
  );

export const newPluginOrbId = (): PluginOrbId =>
  `thr_${crypto.randomUUID()}` as PluginOrbId;

/** The execution stack's key for a plugin Orb: the one place it crosses. */
export const pluginOrbExecutionKey = (id: PluginOrbId): ThreadId =>
  Schema.decodeUnknownSync(ThreadId)(id);

export type PluginOrbScope = "personal" | "workspace";

export interface PluginOrbRecord {
  readonly id: PluginOrbId;
  readonly scope: PluginOrbScope;
  /** The person (personal) or the workspace (workspace). */
  readonly targetId: string;
  /** The install for an Orb of its own; undefined for the shared Orb. */
  readonly pluginId: string | undefined;
  readonly payerUserId: string;
  readonly runnerProfileId: string;
  readonly keepRunning: boolean;
  readonly state: "active" | "stopped" | "removing";
  readonly stoppedReason: string | undefined;
  /** The workspace whose policy and identity apply; none for a person alone. */
  readonly workspaceId: string | undefined;
}

export type ExecutionOwner =
  | { readonly kind: "thread"; readonly threadId: ThreadId }
  | { readonly kind: "plugin-orb"; readonly orb: PluginOrbRecord };

export interface PluginOrbRow {
  readonly id: string;
  readonly scope: string;
  readonly target_id: string;
  readonly plugin_id: string | null;
  readonly payer_user_id: string;
  readonly runner_profile_id: string;
  readonly keep_running: number;
  readonly state: string;
  readonly stopped_reason: string | null;
  readonly workspace_id: string | null;
}

/**
 * Columns of `plugin_orb` (aliased `alias`) for {@link pluginOrbFromRow},
 * with the workspace whose policy applies: the Orb's own workspace, or for
 * a personal Orb its payer's active workspace.
 */
export const pluginOrbColumns = (alias: string) => `${alias}.id, ${alias}.scope,
  ${alias}.target_id, ${alias}.plugin_id, ${alias}.payer_user_id,
  ${alias}.runner_profile_id, ${alias}.keep_running, ${alias}.state,
  ${alias}.stopped_reason,
  CASE WHEN ${alias}.scope = 'workspace' THEN ${alias}.target_id
       ELSE (SELECT member.organizationId FROM member
               JOIN organization ON organization.id = member.organizationId
              WHERE member.userId = ${alias}.payer_user_id
                AND organization.lifecycleState = 'active'
              LIMIT 1)
  END AS workspace_id`;

export const pluginOrbFromRow = (row: PluginOrbRow): PluginOrbRecord => ({
  id: row.id as PluginOrbId,
  scope: row.scope === "workspace" ? "workspace" : "personal",
  targetId: row.target_id,
  pluginId: row.plugin_id ?? undefined,
  payerUserId: row.payer_user_id,
  runnerProfileId: row.runner_profile_id,
  keepRunning: row.keep_running === 1,
  state:
    row.state === "stopped"
      ? "stopped"
      : row.state === "removing"
        ? "removing"
        : "active",
  stoppedReason: row.stopped_reason ?? undefined,
  workspaceId: row.workspace_id ?? undefined,
});

/**
 * SQL predicate: plugin Orb `alias` may run now. It is active, and its payer
 * still owns it: the person themself, or an active member of its workspace.
 */
export const pluginOrbRunnableSql = (alias: string) => `(
  ${alias}.state = 'active'
  AND ((${alias}.scope = 'personal' AND ${alias}.target_id = ${alias}.payer_user_id)
    OR (${alias}.scope = 'workspace'
      AND ${activeMemberSql(`${alias}.target_id`, `${alias}.payer_user_id`)})))`;

export const loadPluginOrb = async (
  db: D1Database,
  id: string,
): Promise<PluginOrbRecord | undefined> => {
  if (!isPluginOrbIdShape(id)) return undefined;
  const row = await db
    .prepare(
      `SELECT ${pluginOrbColumns("orb")} FROM plugin_orb AS orb WHERE orb.id = ?`,
    )
    .bind(id)
    .first<PluginOrbRow>();
  return row === null ? undefined : pluginOrbFromRow(row);
};

/**
 * Whether an Orb belongs to a Thread or to plugins. One read for a plugin
 * Orb; a Thread's Orb costs one indexed probe of `plugin_orb`, made only
 * where a Thread check already failed (see callers).
 */
export const resolveExecutionOwner = async (
  db: D1Database,
  id: string,
): Promise<ExecutionOwner | undefined> => {
  const orb = await loadPluginOrb(db, id);
  if (orb !== undefined) return { kind: "plugin-orb", orb };
  const threadId = Schema.decodeUnknownOption(ThreadId)(id);
  if (Option.isNone(threadId)) return undefined;
  const thread = await db
    .prepare("SELECT 1 AS found FROM threads WHERE id = ?")
    .bind(threadId.value)
    .first<{ found: number }>();
  return thread === null
    ? undefined
    : { kind: "thread", threadId: threadId.value };
};

/** A plugin Orb that may run now, or undefined (absent, stopped, payer gone). */
export const runnablePluginOrb = async (
  db: D1Database,
  id: string,
): Promise<PluginOrbRecord | undefined> => {
  if (!isPluginOrbIdShape(id)) return undefined;
  const row = await db
    .prepare(
      `SELECT ${pluginOrbColumns("orb")} FROM plugin_orb AS orb
        WHERE orb.id = ? AND ${pluginOrbRunnableSql("orb")}`,
    )
    .bind(id)
    .first<PluginOrbRow>();
  return row === null ? undefined : pluginOrbFromRow(row);
};
