import {
  PersistenceUnavailable,
  RunnerProfileId,
  type WorkspaceId,
  WorkspacePolicy,
  type WorkspacePolicyAuditRecord,
  WorkspacePolicyConflict,
  WorkspacePolicyRepository,
} from "@dx/domain";
import { Effect, Layer, Schema } from "effect";

const WorkspacePolicyRow = Schema.Struct({
  workspace_id: Schema.String,
  allowed_runner_profile_ids: Schema.NullOr(Schema.String),
  allow_remote_runners: Schema.Number,
  allow_personal_provider_overrides: Schema.Number,
  allow_personal_mcp_overrides: Schema.Number,
  allow_personal_secret_overrides: Schema.Number,
  allow_personal_plugin_overrides: Schema.Number,
  allow_personal_execution_overrides: Schema.Number,
  revision: Schema.Number,
  updated_at: Schema.DateTimeUtcFromString,
});

const selectPolicy = `SELECT
  workspace_id,
  allowed_runner_profile_ids,
  allow_remote_runners,
  allow_personal_provider_overrides,
  allow_personal_mcp_overrides,
  allow_personal_secret_overrides,
  allow_personal_plugin_overrides,
  allow_personal_execution_overrides,
  revision,
  updated_at
FROM workspace_policy`;

const decodeRunnerProfileIds = (value: string | null) =>
  value === null
    ? Effect.succeed(null)
    : Schema.decodeUnknownEffect(
        Schema.fromJsonString(Schema.Array(RunnerProfileId)),
      )(value);

const decodePolicy = Effect.fn("WorkspacePolicyRepositoryD1.decodePolicy")(
  function* (value: unknown) {
    const row = yield* Schema.decodeUnknownEffect(WorkspacePolicyRow)(value);
    const allowedRunnerProfileIds = yield* decodeRunnerProfileIds(
      row.allowed_runner_profile_ids,
    );
    return yield* Schema.decodeUnknownEffect(WorkspacePolicy)({
      workspaceId: row.workspace_id,
      restrictions: {
        allowedRunnerProfileIds,
        allowRemoteRunners: row.allow_remote_runners === 1,
        allowPersonalProviderOverrides:
          row.allow_personal_provider_overrides === 1,
        allowPersonalMcpOverrides: row.allow_personal_mcp_overrides === 1,
        allowPersonalSecretOverrides: row.allow_personal_secret_overrides === 1,
        allowPersonalPluginOverrides: row.allow_personal_plugin_overrides === 1,
        allowPersonalExecutionOverrides:
          row.allow_personal_execution_overrides === 1,
      },
      revision: row.revision,
      updatedAt: row.updated_at,
    });
  },
);

const insertAudit = (
  db: D1Database,
  audit: WorkspacePolicyAuditRecord,
  onlyAfterChangedPolicy = false,
) =>
  db
    .prepare(
      `INSERT INTO workspace_policy_audit_event (
        id, workspace_id, actor_user_id, request_id, outcome, reason,
        previous_revision, next_revision, changed_fields, created_at
      ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      ${onlyAfterChangedPolicy ? "WHERE changes() = 1" : ""}`,
    )
    .bind(
      audit.id,
      audit.workspaceId,
      audit.actorUserId,
      audit.requestId,
      audit.outcome,
      audit.reason ?? null,
      audit.previousRevision,
      audit.nextRevision ?? null,
      JSON.stringify(audit.changedFields),
      audit.createdAt,
    );

export const WorkspacePolicyRepositoryD1 = (db: D1Database) => {
  const get = Effect.fn("WorkspacePolicyRepository.get")(function* (
    workspaceId: WorkspaceId,
  ) {
    const row = yield* Effect.tryPromise({
      try: () =>
        db
          .prepare(`${selectPolicy} WHERE workspace_id = ? LIMIT 1`)
          .bind(workspaceId)
          .first(),
      catch: (cause) =>
        PersistenceUnavailable.new({ operation: "workspacePolicy.get" }, cause),
    });
    if (row === null) {
      return yield* Effect.fail(
        PersistenceUnavailable.new(
          { operation: "workspacePolicy.get" },
          new Error("Workspace policy row is missing."),
        ),
      );
    }
    return yield* decodePolicy(row);
  });

  return Layer.succeed(
    WorkspacePolicyRepository,
    WorkspacePolicyRepository.of({
      get,
      put: Effect.fn("WorkspacePolicyRepository.put")(
        function* (workspaceId, input, expectedRevision, audit) {
          const updatedAt = audit.createdAt;
          const runnerProfileIds =
            input.restrictions.allowedRunnerProfileIds === null
              ? null
              : JSON.stringify(input.restrictions.allowedRunnerProfileIds);
          const statements = [
            db
              .prepare(
                `UPDATE workspace_policy SET
                allowed_runner_profile_ids = ?,
                allow_remote_runners = ?,
                allow_personal_provider_overrides = ?,
                allow_personal_mcp_overrides = ?,
                allow_personal_secret_overrides = ?,
                allow_personal_plugin_overrides = ?,
                allow_personal_execution_overrides = ?,
                revision = revision + 1,
                updated_at = ?
              WHERE workspace_id = ? AND revision = ?`,
              )
              .bind(
                runnerProfileIds,
                input.restrictions.allowRemoteRunners ? 1 : 0,
                input.restrictions.allowPersonalProviderOverrides ? 1 : 0,
                input.restrictions.allowPersonalMcpOverrides ? 1 : 0,
                input.restrictions.allowPersonalSecretOverrides ? 1 : 0,
                input.restrictions.allowPersonalPluginOverrides ? 1 : 0,
                input.restrictions.allowPersonalExecutionOverrides ? 1 : 0,
                updatedAt,
                workspaceId,
                expectedRevision,
              ),
            insertAudit(db, audit, true),
          ];
          const results = yield* Effect.tryPromise({
            try: () => db.batch(statements),
            catch: (cause) =>
              PersistenceUnavailable.new(
                { operation: "workspacePolicy.put" },
                cause,
              ),
          });
          if ((results[0]?.meta.changes ?? 0) !== 1) {
            const current = yield* Effect.tryPromise({
              try: () =>
                db
                  .prepare(
                    "SELECT revision FROM workspace_policy WHERE workspace_id = ?",
                  )
                  .bind(workspaceId)
                  .first<{ revision: number }>(),
              catch: (cause) =>
                PersistenceUnavailable.new(
                  { operation: "workspacePolicy.conflict" },
                  cause,
                ),
            });
            return yield* new WorkspacePolicyConflict({
              currentRevision: current?.revision ?? expectedRevision,
            });
          }
          const row = yield* Effect.tryPromise({
            try: () =>
              db
                .prepare(`${selectPolicy} WHERE workspace_id = ? LIMIT 1`)
                .bind(workspaceId)
                .first(),
            catch: (cause) =>
              PersistenceUnavailable.new(
                { operation: "workspacePolicy.readAfterPut" },
                cause,
              ),
          });
          if (row === null) {
            return yield* Effect.fail(
              PersistenceUnavailable.new(
                { operation: "workspacePolicy.readAfterPut" },
                new Error("Updated workspace policy row is missing."),
              ),
            );
          }
          return yield* decodePolicy(row);
        },
      ),
      recordRejected: Effect.fn("WorkspacePolicyRepository.recordRejected")(
        function* (audit) {
          yield* Effect.tryPromise({
            try: () => insertAudit(db, audit).run(),
            catch: (cause) =>
              PersistenceUnavailable.new(
                { operation: "workspacePolicy.auditRejected" },
                cause,
              ),
          });
        },
      ),
      allowedRunnerProfileIds: Effect.fn(
        "WorkspacePolicyRepository.allowedRunnerProfileIds",
      )(function* (workspaceId) {
        const policy = yield* get(workspaceId);
        return policy.restrictions.allowedRunnerProfileIds;
      }),
    }),
  );
};
