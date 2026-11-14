import { USAGE_EVENT_RETENTION_DAYS } from "@dx/domain";
import { settingsPersistenceLogger } from "../../logging.js";
import { purgeStartupPhasesBefore } from "../../observability/startup-phase-retention.js";
import { purgeExpiredPluginHostUsage } from "../../plugins/hosts/usage.js";
import { purgeExpiredPluginUsageEvents } from "../../plugins/metering.js";
import { purgeExpiredSubmissionPluginTools } from "../../plugins/submission-tools.js";
import {
  backfillThreadUsageRollup,
  purgeExpiredOrbSessions,
} from "../../thread-usage/repository-d1.js";
import { backfillUsageRollups } from "./rollup-d1.js";
import { backfillWorkspaceUsageRollups } from "./workspace-rollup-d1.js";

// Chunks of 50,000 events: two million stored events a day at most.
const ROLLUP_BACKFILL_CHUNKS = 40;
// Each minute's tick adds one chunk of this many events to the workspace
// rollups (migration 0151) until the events stored before it are in. The
// workspace page answers only from the rollups, so a deploy over a quarter
// million events serves it again within about five minutes, not a day.
const WORKSPACE_ROLLUP_TICK_ROWS = 50_000;

// D1's `changes` also counts the rows the usage rollup triggers change, so
// the events deleted are counted in the same batch, before the delete.
export const purgeExpiredUsageEvents = async (
  db: D1Database,
  before: string,
): Promise<D1Result<unknown>> => {
  const [counted, deleted] = await db.batch([
    db
      .prepare(
        "SELECT COUNT(*) AS events FROM usage_event WHERE expires_at <= ?",
      )
      .bind(before),
    db.prepare("DELETE FROM usage_event WHERE expires_at <= ?").bind(before),
  ]);
  const events = (counted?.results[0] as { events: number } | undefined)
    ?.events;
  if (deleted === undefined || events === undefined)
    throw new Error("Usage retention returned no result.");
  return { ...deleted, meta: { ...deleted.meta, changes: events } };
};

export const purgeExpiredWorkspaceUsageAudit = (
  db: D1Database,
  before: string,
): Promise<D1Result<unknown>> =>
  db
    .batch([
      db
        .prepare(
          `INSERT INTO workspace_usage_audit_retention_gate (singleton, delete_before)
           VALUES (1, ?)
           ON CONFLICT(singleton) DO UPDATE SET delete_before = excluded.delete_before`,
        )
        .bind(before),
      db
        .prepare("DELETE FROM workspace_usage_audit WHERE expires_at <= ?")
        .bind(before),
      db.prepare(
        "DELETE FROM workspace_usage_audit_retention_gate WHERE singleton = 1",
      ),
    ])
    .then((results) => results[1] as D1Result<unknown>);

export const scheduleUsageRetention = (
  controller: ScheduledController,
  bindings: { readonly DB?: D1Database },
  context: ExecutionContext,
) => {
  if (bindings.DB === undefined) {
    settingsPersistenceLogger.error("Usage retention could not run.", {
      event: "usage_retention_failed",
      reason: "d1_binding_unavailable",
    });
    return;
  }
  const before = new Date(controller.scheduledTime).toISOString();
  context.waitUntil(
    Promise.all([
      purgeExpiredUsageEvents(bindings.DB, before),
      purgeExpiredWorkspaceUsageAudit(bindings.DB, before),
      purgeStartupPhasesBefore(bindings.DB, before),
      purgeExpiredPluginUsageEvents(bindings.DB, before),
      purgeExpiredPluginHostUsage(bindings.DB, before),
      purgeExpiredSubmissionPluginTools(bindings.DB, before),
      backfillUsageRollups(bindings.DB, ROLLUP_BACKFILL_CHUNKS),
      backfillWorkspaceUsageRollups(bindings.DB, ROLLUP_BACKFILL_CHUNKS),
      backfillThreadUsageRollup(bindings.DB, ROLLUP_BACKFILL_CHUNKS),
      purgeExpiredOrbSessions(
        bindings.DB,
        controller.scheduledTime - USAGE_EVENT_RETENTION_DAYS * 86_400_000,
      ),
    ])
      .then(
        ([
          usageResult,
          auditResult,
          startupResult,
          pluginResult,
          hostUsageResult,
          toolsResult,
          rollupsBackfilled,
          workspaceRollupsBackfilled,
          threadRollupBackfilled,
        ]) => {
          settingsPersistenceLogger.info("Usage retention completed.", {
            event: "usage_retention_completed",
            deletedEvents: usageResult.meta.changes,
            deletedAuditEvents: auditResult.meta.changes,
            deletedStartupPhases: startupResult.meta.changes,
            deletedPluginUsageEvents: pluginResult.meta.changes,
            deletedPluginHostUsage: hostUsageResult.meta.changes,
            deletedSubmissionPluginTools: toolsResult.meta.changes,
            rollupsBackfilled,
            workspaceRollupsBackfilled,
            threadRollupBackfilled,
          });
        },
      )
      .catch(() => {
        settingsPersistenceLogger.error("Usage retention failed.", {
          event: "usage_retention_failed",
          reason: "persistence_unavailable",
        });
      }),
  );
};

/** One tick's chunk of the workspace rollup backfill; nothing once done. */
export const scheduleWorkspaceUsageBackfill = (
  bindings: { readonly DB?: D1Database },
  context: ExecutionContext,
) => {
  if (bindings.DB === undefined) return;
  const db = bindings.DB;
  context.waitUntil(
    Promise.all([
      backfillWorkspaceUsageRollups(db, 1, WORKSPACE_ROLLUP_TICK_ROWS),
      // The Thread rollup (migration 0161) too: the Cost & Usage dialog sums
      // a Thread's raw model events until it is done.
      backfillThreadUsageRollup(db, 1, WORKSPACE_ROLLUP_TICK_ROWS),
    ]).catch(() => {
      settingsPersistenceLogger.error("Workspace usage backfill failed.", {
        event: "workspace_usage_backfill_failed",
        reason: "persistence_unavailable",
      });
    }),
  );
};
