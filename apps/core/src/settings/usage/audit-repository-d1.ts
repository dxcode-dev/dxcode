import {
  decodeWorkspaceUsageAuditCursor,
  encodeWorkspaceUsageAuditCursor,
  PersistenceUnavailable,
  ProjectId,
  ThreadId,
  UserId,
  WorkspaceId,
  WorkspacePrivateThreadInspectionReason,
  WorkspaceThreadLifecycle,
  WorkspaceThreadVisibility,
  WorkspaceUsageAuditId,
  WorkspaceUsageAuditRepository,
  WorkspaceUsageAuditResult,
} from "@dx/domain";
import { Effect, Layer, Option, Schema } from "effect";

const InspectionTargetRow = Schema.Struct({
  thread_id: ThreadId,
  project_id: ProjectId,
  project_name: Schema.String,
  owner_user_id: UserId,
  visibility: WorkspaceThreadVisibility,
  lifecycle: WorkspaceThreadLifecycle,
  created_at: Schema.DateTimeUtcFromString,
  updated_at: Schema.DateTimeUtcFromString,
  total_tokens: Schema.Number,
  unknown_token_events: Schema.Number,
  model_turns: Schema.Number,
  average_latency_ms: Schema.NullOr(Schema.Number),
  runner_duration_ms: Schema.Number,
  first_observed_at: Schema.NullOr(Schema.DateTimeUtcFromString),
  last_observed_at: Schema.NullOr(Schema.DateTimeUtcFromString),
});

const AuditRow = Schema.Struct({
  id: WorkspaceUsageAuditId,
  workspace_id: WorkspaceId,
  actor_user_id: UserId,
  actor_name: Schema.String,
  reason: WorkspacePrivateThreadInspectionReason,
  target_thread_id: ThreadId,
  occurred_at: Schema.DateTimeUtcFromString,
  expires_at: Schema.DateTimeUtcFromString,
  result: WorkspaceUsageAuditResult,
});

const unavailable = (operation: string, cause: unknown) =>
  PersistenceUnavailable.new({ operation }, cause);

const run = <Value>(operation: string, attempt: () => Promise<Value>) =>
  Effect.tryPromise({
    try: attempt,
    catch: (cause) => unavailable(operation, cause),
  });

const asString = (value: typeof Schema.DateTimeUtc.Type) =>
  Schema.encodeSync(Schema.DateTimeUtcFromString)(value);

export const WorkspaceUsageAuditRepositoryD1 = (db: D1Database) =>
  Layer.succeed(
    WorkspaceUsageAuditRepository,
    WorkspaceUsageAuditRepository.of({
      findInspectionTarget: (workspaceId, threadId) =>
        Effect.gen(function* () {
          const result = yield* run("usage.audit.findInspectionTarget", () =>
            db
              .prepare(
                `SELECT
                   thread.id AS thread_id,
                   thread.project_id,
                   project.name AS project_name,
                   thread.owner_user_id,
                   thread.visibility,
                   thread.lifecycle_state AS lifecycle,
                   thread.created_at,
                   thread.updated_at,
                   COALESCE(SUM(CASE WHEN event.kind = 'model' THEN event.total_tokens ELSE 0 END), 0) AS total_tokens,
                   COALESCE(SUM(CASE WHEN event.kind = 'model' AND event.total_tokens IS NULL THEN 1 ELSE 0 END), 0) AS unknown_token_events,
                   COALESCE(SUM(CASE WHEN event.kind = 'model' THEN 1 ELSE 0 END), 0) AS model_turns,
                   AVG(CASE WHEN event.kind = 'model' THEN event.duration_ms END) AS average_latency_ms,
                   COALESCE(SUM(CASE WHEN event.kind = 'runner' THEN event.duration_ms ELSE 0 END), 0) AS runner_duration_ms,
                   MIN(event.occurred_at) AS first_observed_at,
                   MAX(event.occurred_at) AS last_observed_at
                 FROM threads AS thread
                 INNER JOIN projects AS project ON project.id = thread.project_id
                 INNER JOIN member
                   ON member.userId = thread.owner_user_id
                  AND member.organizationId = ?
                 LEFT JOIN usage_event AS event
                   ON event.thread_id = thread.id
                  AND event.workspace_id = ?
                 WHERE thread.id = ?
                 GROUP BY thread.id, project.id`,
              )
              .bind(workspaceId, workspaceId, threadId)
              .all(),
          );
          const rows = yield* Schema.decodeUnknownEffect(
            Schema.Array(InspectionTargetRow),
          )(result.results);
          const row = rows[0];
          return Option.fromNullishOr(
            row === undefined
              ? undefined
              : {
                  threadId: row.thread_id,
                  projectId: row.project_id,
                  projectName: row.project_name,
                  ownerUserId: row.owner_user_id,
                  visibility: row.visibility,
                  lifecycle: row.lifecycle,
                  createdAt: row.created_at,
                  updatedAt: row.updated_at,
                  usage: {
                    totalTokens: row.total_tokens,
                    unknownTokenEvents: row.unknown_token_events,
                    modelTurns: row.model_turns,
                    averageLatencyMs: row.average_latency_ms,
                    runnerDurationMs: row.runner_duration_ms,
                    firstObservedAt: row.first_observed_at,
                    lastObservedAt: row.last_observed_at,
                  },
                },
          );
        }),
      append: (event) =>
        run("usage.audit.append", () =>
          db
            .prepare(
              `INSERT INTO workspace_usage_audit (
                 id, workspace_id, actor_user_id, reason, target_thread_id,
                 occurred_at, expires_at, result
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
              event.id,
              event.workspaceId,
              event.actorUserId,
              event.reason,
              event.targetThreadId,
              asString(event.occurredAt),
              asString(event.expiresAt),
              event.result,
            )
            .run(),
        ).pipe(Effect.asVoid),
      list: (workspaceId, query) =>
        Effect.gen(function* () {
          const cursor =
            query.cursor === undefined
              ? undefined
              : yield* decodeWorkspaceUsageAuditCursor(query.cursor);
          const conditions = [
            "audit.workspace_id = ?",
            "audit.occurred_at >= ?",
            "audit.occurred_at < ?",
          ];
          const bindings: Array<unknown> = [
            workspaceId,
            query.fromInclusive,
            query.toExclusive,
          ];
          for (const [column, value] of [
            ["audit.actor_user_id", query.actorUserId],
            ["audit.target_thread_id", query.threadId],
            ["audit.result", query.result],
          ] as const) {
            if (value !== undefined) {
              conditions.push(`${column} = ?`);
              bindings.push(value);
            }
          }
          if (cursor !== undefined) {
            conditions.push(
              "(audit.occurred_at < ? OR (audit.occurred_at = ? AND audit.id < ?))",
            );
            const occurredAt = asString(cursor.occurredAt);
            bindings.push(occurredAt, occurredAt, cursor.id);
          }
          bindings.push(query.limit + 1);
          const result = yield* run("usage.audit.list", () =>
            db
              .prepare(
                `SELECT
                   audit.id,
                   audit.workspace_id,
                   audit.actor_user_id,
                   COALESCE(personal_account.display_name, user.name, 'Former workspace member') AS actor_name,
                   audit.reason,
                   audit.target_thread_id,
                   audit.occurred_at,
                   audit.expires_at,
                   audit.result
                 FROM workspace_usage_audit AS audit
                 LEFT JOIN user ON user.id = audit.actor_user_id
                 LEFT JOIN personal_account ON personal_account.user_id = audit.actor_user_id
                 WHERE ${conditions.join(" AND ")}
                 ORDER BY audit.occurred_at DESC, audit.id DESC
                 LIMIT ?`,
              )
              .bind(...bindings)
              .all(),
          );
          const decoded = yield* Schema.decodeUnknownEffect(
            Schema.Array(AuditRow),
          )(result.results);
          const items = decoded.slice(0, query.limit).map((row) => ({
            id: row.id,
            workspaceId: row.workspace_id,
            actorUserId: row.actor_user_id,
            actorName: row.actor_name,
            reason: row.reason,
            targetThreadId: row.target_thread_id,
            occurredAt: row.occurred_at,
            expiresAt: row.expires_at,
            result: row.result,
          }));
          const last = items.at(-1);
          const nextCursor =
            decoded.length > query.limit && last !== undefined
              ? yield* encodeWorkspaceUsageAuditCursor({
                  occurredAt: last.occurredAt,
                  id: last.id,
                })
              : undefined;
          return {
            items,
            ...(nextCursor === undefined ? {} : { nextCursor }),
          };
        }),
    }),
  );
