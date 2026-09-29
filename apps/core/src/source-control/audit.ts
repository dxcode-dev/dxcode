import {
  SourceControlLeaseFailure,
  type SourceOperationInvocationSourceType,
  type SourceOperationType,
} from "@dx/domain";
import { Context, Effect, Layer } from "effect";
import { sourceControlAuditLogger } from "../logging.js";

export interface SourceAuditRecord {
  readonly operationId: string;
  readonly occurredAt: string;
  readonly actorUserId: string;
  readonly projectId?: string;
  readonly threadId?: string;
  readonly provider?: "github" | "gitlab" | "forgejo";
  readonly providerRepositoryId?: string;
  readonly requestedCapabilities: ReadonlyArray<SourceOperationType>;
  readonly credentialClass: "none" | "github-app-installation";
  readonly invocationSource: SourceOperationInvocationSourceType;
  readonly outcome:
    | "success"
    | "denied"
    | "provider-failed"
    | "callback-failed"
    | "interrupted";
  readonly reason?: string;
  readonly durationMs: number;
}

export interface SourceAuditShape {
  readonly record: (
    record: SourceAuditRecord,
  ) => Effect.Effect<void, SourceControlLeaseFailure>;
}

export class SourceAudit extends Context.Service<
  SourceAudit,
  SourceAuditShape
>()("@dx/core/source-control/SourceAudit") {}

const failure = () =>
  new SourceControlLeaseFailure({
    reason: "audit-unavailable",
    retryable: true,
  });

export const SourceAuditD1 = (db: D1Database) =>
  Layer.succeed(
    SourceAudit,
    SourceAudit.of({
      record: (record) =>
        Effect.tryPromise({
          try: () =>
            db
              .prepare(`
                INSERT INTO source_control_operation_audit (
                  operation_id, occurred_at, actor_user_id, project_id, thread_id,
                  provider, provider_repository_id, requested_capabilities_json,
                  credential_class, invocation_source, outcome, reason, duration_ms
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              `)
              .bind(
                record.operationId,
                record.occurredAt,
                record.actorUserId,
                record.projectId ?? null,
                record.threadId ?? null,
                record.provider ?? null,
                record.providerRepositoryId ?? null,
                JSON.stringify(record.requestedCapabilities),
                record.credentialClass,
                record.invocationSource,
                record.outcome,
                record.reason ?? null,
                Math.max(0, Math.round(record.durationMs)),
              )
              .run()
              .then(() => undefined),
          catch: failure,
        }).pipe(
          Effect.tap(() =>
            Effect.sync(() =>
              sourceControlAuditLogger.info(
                "Source-control operation audit recorded.",
                {
                  operationId: record.operationId,
                  actorUserId: record.actorUserId,
                  projectId: record.projectId,
                  threadId: record.threadId,
                  provider: record.provider,
                  providerRepositoryId: record.providerRepositoryId,
                  requestedCapabilities: record.requestedCapabilities,
                  credentialClass: record.credentialClass,
                  invocationSource: record.invocationSource,
                  outcome: record.outcome,
                  reason: record.reason,
                  durationMs: Math.max(0, Math.round(record.durationMs)),
                },
              ),
            ),
          ),
        ),
    }),
  );

export const purgeSourceAuditBefore = (
  db: D1Database,
  deleteBefore: string,
  gateExpiresAt: string,
) =>
  Effect.tryPromise({
    try: () =>
      db
        .batch([
          db
            .prepare(
              "INSERT INTO source_control_audit_retention_gate (id, delete_before, expires_at) VALUES (1, ?, ?)",
            )
            .bind(deleteBefore, gateExpiresAt),
          db
            .prepare(
              "DELETE FROM source_control_operation_audit WHERE occurred_at < ?",
            )
            .bind(deleteBefore),
          db.prepare(
            "DELETE FROM source_control_audit_retention_gate WHERE id = 1",
          ),
        ])
        .then(() => undefined),
    catch: failure,
  });
