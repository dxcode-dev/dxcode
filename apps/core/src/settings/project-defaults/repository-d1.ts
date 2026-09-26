import {
  PersonalProjectDefaults,
  PersistenceUnavailable,
  ProjectDefaultsConflict,
  ProjectDefaultsRepository,
  RunnerProfileId,
  Timestamp,
  type UserId,
  type WorkspaceId,
  WorkspaceProjectDefaults,
} from "@dx/domain";
import { DateTime, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

const PersonalDefaultsRow = Schema.Struct({
  user_id: Schema.String,
  ship_action: Schema.NullOr(Schema.String),
  commit_author_preference: Schema.NullOr(Schema.String),
  signing_preference: Schema.NullOr(Schema.String),
  runner_profile_id: Schema.NullOr(Schema.String),
  revision: Schema.Number,
  updated_at: Schema.String,
});

const WorkspaceDefaultsRow = Schema.Struct({
  workspace_id: Schema.String,
  ship_action: Schema.NullOr(Schema.String),
  commit_author_preference: Schema.NullOr(Schema.String),
  signing_preference: Schema.NullOr(Schema.String),
  runner_profile_id: Schema.NullOr(Schema.String),
  allow_member_project_creation: Schema.Number,
  allow_public_code_access: Schema.Number,
  allowed_runner_profile_ids: Schema.NullOr(Schema.String),
  revision: Schema.Number,
  updated_at: Schema.String,
});

const emptyOverrides = {
  shipAction: null,
  commitAuthor: null,
  signingPreference: null,
  runnerProfileId: null,
} as const;

const decodePersonal = (row: typeof PersonalDefaultsRow.Type) =>
  Schema.decodeUnknownEffect(PersonalProjectDefaults)({
    userId: row.user_id,
    overrides: {
      shipAction: row.ship_action,
      commitAuthor: row.commit_author_preference,
      signingPreference: row.signing_preference,
      runnerProfileId: row.runner_profile_id,
    },
    revision: row.revision,
    updatedAt: row.updated_at,
  });

const decodeAllowedRunnerProfileIds = (input: string | null) =>
  input === null
    ? Effect.succeed(null)
    : Schema.decodeUnknownEffect(
        Schema.fromJsonString(Schema.Array(RunnerProfileId)),
      )(input);

const decodeWorkspace = Effect.fn("decodeWorkspaceProjectDefaults")(function* (
  row: typeof WorkspaceDefaultsRow.Type,
) {
  return yield* Schema.decodeUnknownEffect(WorkspaceProjectDefaults)({
    workspaceId: row.workspace_id,
    overrides: {
      shipAction: row.ship_action,
      commitAuthor: row.commit_author_preference,
      signingPreference: row.signing_preference,
      runnerProfileId: row.runner_profile_id,
    },
    policy: {
      allowMemberProjectCreation: row.allow_member_project_creation === 1,
      allowPublicCodeAccess: row.allow_public_code_access === 1,
      allowedRunnerProfileIds: yield* decodeAllowedRunnerProfileIds(
        row.allowed_runner_profile_ids,
      ),
    },
    revision: row.revision,
    updatedAt: row.updated_at,
  });
});

export const ProjectDefaultsRepositoryD1 = Layer.effect(
  ProjectDefaultsRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const unavailable = (operation: string) => (cause: unknown) =>
      PersistenceUnavailable.new({ operation }, cause);

    const getPersonal = Effect.fn("ProjectDefaultsRepository.getPersonal")(
      function* (userId: UserId) {
        const rows = yield* sql`
          SELECT user_id, ship_action, commit_author_preference,
            signing_preference, runner_profile_id, revision, updated_at
          FROM personal_project_defaults
          WHERE user_id = ${userId}
        `.pipe(
          Effect.catchTag("SqlError", (cause) =>
            Effect.fail(unavailable("projectDefaults.getPersonal")(cause)),
          ),
          Effect.flatMap(
            Schema.decodeUnknownEffect(Schema.Array(PersonalDefaultsRow)),
          ),
        );
        const row = rows[0];
        return row === undefined
          ? yield* Schema.decodeUnknownEffect(PersonalProjectDefaults)({
              userId,
              overrides: emptyOverrides,
              revision: 0,
              updatedAt: null,
            })
          : yield* decodePersonal(row);
      },
    );

    const getWorkspace = Effect.fn("ProjectDefaultsRepository.getWorkspace")(
      function* (workspaceId: WorkspaceId) {
        const rows = yield* sql`
          SELECT workspace_id, ship_action, commit_author_preference,
            signing_preference, runner_profile_id,
            allow_member_project_creation, allow_public_code_access,
            allowed_runner_profile_ids, revision, updated_at
          FROM workspace_project_defaults
          WHERE workspace_id = ${workspaceId}
        `.pipe(
          Effect.catchTag("SqlError", (cause) =>
            Effect.fail(unavailable("projectDefaults.getWorkspace")(cause)),
          ),
          Effect.flatMap(
            Schema.decodeUnknownEffect(Schema.Array(WorkspaceDefaultsRow)),
          ),
        );
        const row = rows[0];
        return row === undefined
          ? yield* Schema.decodeUnknownEffect(WorkspaceProjectDefaults)({
              workspaceId,
              overrides: emptyOverrides,
              policy: {
                allowMemberProjectCreation: true,
                allowPublicCodeAccess: false,
                allowedRunnerProfileIds: null,
              },
              revision: 0,
              updatedAt: null,
            })
          : yield* decodeWorkspace(row);
      },
    );

    return ProjectDefaultsRepository.of({
      getPersonal,
      putPersonal: Effect.fn("ProjectDefaultsRepository.putPersonal")(
        function* (userId, overrides, expectedRevision) {
          const updatedAt = yield* DateTime.now.pipe(
            Effect.flatMap(Schema.encodeEffect(Timestamp)),
          );
          const rows = yield* sql`
            INSERT INTO personal_project_defaults (
              user_id, ship_action, commit_author_preference,
              signing_preference, runner_profile_id, revision, updated_at
            )
            SELECT ${userId}, ${overrides.shipAction},
              ${overrides.commitAuthor}, ${overrides.signingPreference},
              ${overrides.runnerProfileId}, 1, ${updatedAt}
            WHERE ${expectedRevision} = 0
              OR EXISTS (
                SELECT 1 FROM personal_project_defaults
                WHERE user_id = ${userId} AND revision = ${expectedRevision}
              )
            ON CONFLICT(user_id) DO UPDATE SET
              ship_action = excluded.ship_action,
              commit_author_preference = excluded.commit_author_preference,
              signing_preference = excluded.signing_preference,
              runner_profile_id = excluded.runner_profile_id,
              revision = personal_project_defaults.revision + 1,
              updated_at = excluded.updated_at
            WHERE personal_project_defaults.revision = ${expectedRevision}
            RETURNING user_id, ship_action, commit_author_preference,
              signing_preference, runner_profile_id, revision, updated_at
          `.pipe(
            Effect.catchTag("SqlError", (cause) =>
              Effect.fail(unavailable("projectDefaults.putPersonal")(cause)),
            ),
            Effect.flatMap(
              Schema.decodeUnknownEffect(Schema.Array(PersonalDefaultsRow)),
            ),
          );
          const row = rows[0];
          return row === undefined
            ? yield* new ProjectDefaultsConflict()
            : yield* decodePersonal(row);
        },
      ),
      getWorkspace,
      putWorkspace: Effect.fn("ProjectDefaultsRepository.putWorkspace")(
        function* (workspaceId, overrides, policy, expectedRevision) {
          const updatedAt = yield* DateTime.now.pipe(
            Effect.flatMap(Schema.encodeEffect(Timestamp)),
          );
          const allowedRunnerProfileIds =
            policy.allowedRunnerProfileIds === null
              ? null
              : yield* Schema.encodeEffect(
                  Schema.fromJsonString(Schema.Array(RunnerProfileId)),
                )(policy.allowedRunnerProfileIds);
          const rows = yield* sql`
            INSERT INTO workspace_project_defaults (
              workspace_id, ship_action, commit_author_preference,
              signing_preference, runner_profile_id,
              allow_member_project_creation, allow_public_code_access,
              allowed_runner_profile_ids, revision, updated_at
            )
            SELECT ${workspaceId}, ${overrides.shipAction},
              ${overrides.commitAuthor}, ${overrides.signingPreference},
              ${overrides.runnerProfileId},
              ${policy.allowMemberProjectCreation ? 1 : 0},
              ${policy.allowPublicCodeAccess ? 1 : 0},
              ${allowedRunnerProfileIds}, 1, ${updatedAt}
            WHERE ${expectedRevision} = 0
              OR EXISTS (
                SELECT 1 FROM workspace_project_defaults
                WHERE workspace_id = ${workspaceId}
                  AND revision = ${expectedRevision}
              )
            ON CONFLICT(workspace_id) DO UPDATE SET
              ship_action = excluded.ship_action,
              commit_author_preference = excluded.commit_author_preference,
              signing_preference = excluded.signing_preference,
              runner_profile_id = excluded.runner_profile_id,
              allow_member_project_creation = excluded.allow_member_project_creation,
              allow_public_code_access = excluded.allow_public_code_access,
              allowed_runner_profile_ids = excluded.allowed_runner_profile_ids,
              revision = workspace_project_defaults.revision + 1,
              updated_at = excluded.updated_at
            WHERE workspace_project_defaults.revision = ${expectedRevision}
            RETURNING workspace_id, ship_action, commit_author_preference,
              signing_preference, runner_profile_id,
              allow_member_project_creation, allow_public_code_access,
              allowed_runner_profile_ids, revision, updated_at
          `.pipe(
            Effect.catchTag("SqlError", (cause) =>
              Effect.fail(unavailable("projectDefaults.putWorkspace")(cause)),
            ),
            Effect.flatMap(
              Schema.decodeUnknownEffect(Schema.Array(WorkspaceDefaultsRow)),
            ),
          );
          const row = rows[0];
          return row === undefined
            ? yield* new ProjectDefaultsConflict()
            : yield* decodeWorkspace(row);
        },
      ),
    });
  }),
);
