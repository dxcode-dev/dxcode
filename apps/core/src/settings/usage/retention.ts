import { settingsPersistenceLogger } from "../../logging.js";
import { purgeStartupPhasesBefore } from "../../observability/startup-phase-retention.js";

export const purgeExpiredUsageEvents = (
  db: D1Database,
  before: string,
): Promise<D1Result<unknown>> =>
  db
    .prepare("DELETE FROM usage_event WHERE expires_at <= ?")
    .bind(before)
    .run();

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
    ])
      .then(([usageResult, auditResult, startupResult]) => {
        settingsPersistenceLogger.info("Usage retention completed.", {
          event: "usage_retention_completed",
          deletedEvents: usageResult.meta.changes,
          deletedAuditEvents: auditResult.meta.changes,
          deletedStartupPhases: startupResult.meta.changes,
        });
      })
      .catch(() => {
        settingsPersistenceLogger.error("Usage retention failed.", {
          event: "usage_retention_failed",
          reason: "persistence_unavailable",
        });
      }),
  );
};
