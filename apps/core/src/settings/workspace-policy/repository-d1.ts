import {
  PersistenceUnavailable,
  RunnerProfileId,
  SettingsMembershipInvariantViolation,
  type WorkspaceId,
  WorkspacePolicy,
  type WorkspacePolicyAuditRecord,
  WorkspacePolicyConflict,
  WorkspacePolicyRepository,
} from "@dx/domain";
import { Effect, Layer, Schema } from "effect";
import { settingsPersistenceLogger } from "../../logging.js";

const WorkspacePolicyRow = Schema.Struct({
  workspace_id: Schema.String,
  allowed_runner_profile_ids: Schema.NullOr(Schema.String),
  allow_remote_runners: Schema.Number,
  allow_personal_provider_overrides: Schema.Number,
  allow_personal_mcp_overrides: Schema.Number,
  allow_personal_secret_overrides: Schema.Number,
  allow_personal_plugin_overrides: Schema.Number,
  allow_personal_execution_overrides: Schema.Number,
  allow_personal_plugin_install_overrides: Schema.Number,
  allow_repository_plugins: Schema.Number,
  plugin_tier_cap: Schema.String,
  trusted_plugin_project_ids: Schema.String,
  trusted_plugin_signers: Schema.String,
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
  allow_personal_plugin_install_overrides,
  allow_repository_plugins,
  plugin_tier_cap,
  trusted_plugin_project_ids,
  trusted_plugin_signers,
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
        allowPersonalPluginInstallOverrides:
          row.allow_personal_plugin_install_overrides === 1,
        allowRepositoryPlugins: row.allow_repository_plugins === 1,
        pluginTierCap: row.plugin_tier_cap,
        trustedPluginProjectIds: JSON.parse(row.trusted_plugin_project_ids),
        trustedPluginSigners: JSON.parse(row.trusted_plugin_signers),
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
                allow_personal_plugin_install_overrides = ?,
                allow_repository_plugins = ?,
                plugin_tier_cap = COALESCE(?, plugin_tier_cap),
                trusted_plugin_project_ids = COALESCE(?, trusted_plugin_project_ids),
                trusted_plugin_signers = COALESCE(?, trusted_plugin_signers),
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
                input.restrictions.allowPersonalPluginInstallOverrides ? 1 : 0,
                input.restrictions.allowRepositoryPlugins ? 1 : 0,
                input.restrictions.pluginTierCap ?? null,
                input.restrictions.trustedPluginProjectIds === undefined
                  ? null
                  : JSON.stringify(input.restrictions.trustedPluginProjectIds),
                input.restrictions.trustedPluginSigners === undefined
                  ? null
                  : JSON.stringify(input.restrictions.trustedPluginSigners),
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

/** The user's workspace as `findByUser` finds it; `owner` is an SQL expression. */
const ownerWorkspace = (owner: string) => `SELECT member.organizationId
  FROM member
  INNER JOIN organization ON organization.id = member.organizationId
  WHERE member.userId = ${owner}
  ORDER BY organization.id`;

/**
 * SQL for the ID of the workspace a user belongs to, or NULL, for callers
 * that read it in the same batch. `owner` is an SQL expression for the user.
 */
export const ownerWorkspaceIdSql = (owner: string) =>
  `(${ownerWorkspace(owner)} LIMIT 1)`;

/**
 * A user's membership and its workspace policy as two statements for a
 * caller's D1 batch, so call-time admission reads them in the same round trip
 * as everything else. `owner` is an SQL expression for the user ID, such as
 * `?1` or a Thread owner subquery, and `bindings` are its parameters.
 */
export const ownerPolicyStatements = (
  db: D1Database,
  owner: string,
  bindings: ReadonlyArray<unknown>,
): readonly [D1PreparedStatement, D1PreparedStatement] => [
  db
    .prepare(
      `SELECT organizationId AS workspace_id FROM (${ownerWorkspace(owner)} LIMIT 2)`,
    )
    .bind(...bindings),
  db
    .prepare(
      `${selectPolicy} WHERE workspace_id = ${ownerWorkspaceIdSql(owner)} LIMIT 1`,
    )
    .bind(...bindings),
];

export interface OwnerPolicy {
  /** Undefined when the user belongs to no workspace. */
  readonly workspaceId: WorkspaceId | undefined;
  /** Present exactly when `workspaceId` is. */
  readonly policy: WorkspacePolicy | undefined;
}

/**
 * Decodes the results of `ownerPolicyStatements`. It fails as the
 * repositories do: two memberships break the one-workspace invariant, and a
 * member's workspace without a policy row is a persistence failure.
 */
export const decodeOwnerPolicy = async (
  membership: D1Result,
  policy: D1Result,
  options: { readonly requirePolicy: boolean },
): Promise<OwnerPolicy> => {
  const rows = membership.results as ReadonlyArray<{ workspace_id: string }>;
  if (rows.length > 1)
    throw new Error("Workspace membership invariant was violated.");
  const workspaceId = rows[0]?.workspace_id as WorkspaceId | undefined;
  if (workspaceId === undefined || !options.requirePolicy)
    return { workspaceId, policy: undefined };
  const row = policy.results[0];
  if (row === undefined) throw new Error("Workspace policy row is missing.");
  return { workspaceId, policy: await Effect.runPromise(decodePolicy(row)) };
};

/**
 * The owner's workspace policy from `ownerPolicyStatements`' results, failing
 * as `WorkspacePolicyService.evaluateForUser`'s two reads do: two
 * memberships break the one-workspace invariant, and a member's workspace
 * without a policy row is a persistence failure. `undefined` when the owner
 * belongs to no workspace.
 */
export const ownerPolicyFrom = Effect.fn(
  "WorkspacePolicyRepositoryD1.ownerPolicyFrom",
)(function* (membership: D1Result, policy: D1Result) {
  const rows = membership.results as ReadonlyArray<{ workspace_id: string }>;
  if (rows.length > 1) {
    settingsPersistenceLogger.error(
      "Workspace membership invariant was violated.",
      { event: "workspace_membership_invariant_failed" },
    );
    return yield* new SettingsMembershipInvariantViolation();
  }
  if (rows[0] === undefined) return undefined;
  const row = policy.results[0];
  if (row === undefined)
    return yield* Effect.fail(
      PersistenceUnavailable.new(
        { operation: "workspacePolicy.get" },
        new Error("Workspace policy row is missing."),
      ),
    );
  return yield* decodePolicy(row);
});
