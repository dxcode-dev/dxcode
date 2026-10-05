import { type MeteredPluginCall, USAGE_EVENT_RETENTION_DAYS } from "@dx/domain";
import { settingsPersistenceLogger } from "../logging.js";

/**
 * Records one metered provider call. Attribution (owner, workspace, Project)
 * is derived from the Thread row exactly as `usage_event` does, and rows
 * share its retention window. Pricing and charging read these rows; no
 * provider or tool branches on who pays.
 */
export const recordMeteredCall = async (
  db: D1Database,
  threadId: string,
  call: MeteredPluginCall,
  occurredAt = new Date().toISOString(),
): Promise<void> => {
  await db
    .prepare(
      `INSERT INTO plugin_usage_event (
         id, owner_user_id, workspace_id, thread_id, project_id, submission_id,
         plugin_id,
         provider_id, capability, credential_scope, unit, units, outcome,
         duration_ms, occurred_at, expires_at
       )
       SELECT ?, thread.owner_user_id,
         (SELECT member.organizationId FROM member
          WHERE member.userId = thread.owner_user_id LIMIT 1),
         thread.id, thread.project_id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
         strftime('%Y-%m-%dT%H:%M:%fZ', ?, '+${USAGE_EVENT_RETENTION_DAYS} days')
       FROM threads AS thread
       WHERE thread.id = ?`,
    )
    .bind(
      `pue_${crypto.randomUUID()}`,
      call.submissionId,
      call.pluginId,
      call.providerId,
      call.capability,
      call.credentialScope,
      call.unit,
      call.units,
      call.outcome,
      call.durationMs,
      occurredAt,
      occurredAt,
      threadId,
    )
    .run();
};

/**
 * Records one metered call made for a user outside a Thread, such as composer
 * dictation. The row has no Thread or Project; the workspace is the owner's
 * membership, as for Thread calls.
 */
export const recordUserMeteredCall = async (
  db: D1Database,
  userId: string,
  call: MeteredPluginCall,
  occurredAt = new Date().toISOString(),
): Promise<void> => {
  await db
    .prepare(
      `INSERT INTO plugin_usage_event (
         id, owner_user_id, workspace_id, thread_id, project_id, submission_id,
         plugin_id,
         provider_id, capability, credential_scope, unit, units, outcome,
         duration_ms, occurred_at, expires_at
       ) VALUES (?, ?,
         (SELECT member.organizationId FROM member
          WHERE member.userId = ? LIMIT 1),
         NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
         strftime('%Y-%m-%dT%H:%M:%fZ', ?, '+${USAGE_EVENT_RETENTION_DAYS} days'))`,
    )
    .bind(
      `pue_${crypto.randomUUID()}`,
      userId,
      userId,
      call.submissionId,
      call.pluginId,
      call.providerId,
      call.capability,
      call.credentialScope,
      call.unit,
      call.units,
      call.outcome,
      call.durationMs,
      occurredAt,
      occurredAt,
    )
    .run();
};

/** Metering never fails the call it describes; failures are logged. */
export const recordUserMeteredCallSafely = (
  db: D1Database,
  userId: string,
  call: MeteredPluginCall,
) =>
  recordUserMeteredCall(db, userId, call).catch(() => {
    settingsPersistenceLogger.error("Plugin usage could not be recorded.", {
      event: "plugin_usage_record_failed",
      pluginId: call.pluginId,
      providerId: call.providerId,
      capability: call.capability,
      credentialScope: call.credentialScope,
    });
  });

/** Metering never fails the tool call it describes; failures are logged. */
export const recordMeteredCallSafely = (
  db: D1Database,
  threadId: string,
  call: MeteredPluginCall,
) =>
  recordMeteredCall(db, threadId, call).catch(() => {
    settingsPersistenceLogger.error("Plugin usage could not be recorded.", {
      event: "plugin_usage_record_failed",
      threadId,
      pluginId: call.pluginId,
      providerId: call.providerId,
      capability: call.capability,
      credentialScope: call.credentialScope,
    });
  });

export const purgeExpiredPluginUsageEvents = (
  db: D1Database,
  before: string,
): Promise<D1Result<unknown>> =>
  db
    .prepare("DELETE FROM plugin_usage_event WHERE expires_at <= ?")
    .bind(before)
    .run();
