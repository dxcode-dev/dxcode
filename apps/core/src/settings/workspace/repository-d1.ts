import {
  PersistenceUnavailable,
  SettingsMembershipInvariantViolation,
  type UserId,
  WorkspaceMembership,
  WorkspaceMembershipExists,
  WorkspaceNotFound,
  WorkspaceProfile,
  WorkspaceProfileConflict,
  WorkspaceRepository,
  type WorkspaceShortName,
  WorkspaceShortNameUnavailable,
} from "@dx/domain";
import { Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { settingsPersistenceLogger } from "../../logging.js";

const WorkspaceMembershipRow = Schema.Struct({
  workspace_id: Schema.String,
  display_name: Schema.String,
  short_name: Schema.String,
  lifecycle_state: Schema.String,
  profile_revision: Schema.Number,
  user_id: Schema.String,
  role: Schema.String,
});

const WorkspaceProfileRow = Schema.Struct({
  workspace_id: Schema.String,
  display_name: Schema.String,
  short_name: Schema.String,
  lifecycle_state: Schema.String,
  profile_revision: Schema.Number,
});

const membershipFrom = (row: typeof WorkspaceMembershipRow.Type) =>
  Schema.decodeUnknownEffect(WorkspaceMembership)({
    workspace: {
      id: row.workspace_id,
      displayName: row.display_name,
      shortName: row.short_name,
      lifecycleState: row.lifecycle_state,
      revision: row.profile_revision,
    },
    userId: row.user_id,
    role: row.role,
  });

const profileFrom = (row: typeof WorkspaceProfileRow.Type) =>
  Schema.decodeUnknownEffect(WorkspaceProfile)({
    id: row.workspace_id,
    displayName: row.display_name,
    shortName: row.short_name,
    lifecycleState: row.lifecycle_state,
    revision: row.profile_revision,
  });

export const WorkspaceRepositoryD1 = (db: D1Database) =>
  Layer.effect(
    WorkspaceRepository,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const unavailable = (operation: string) => (cause: unknown) =>
        PersistenceUnavailable.new({ operation }, cause);

      const findByUser = Effect.fn("WorkspaceRepository.findByUser")(function* (
        userId: UserId,
      ) {
        const rows = yield* sql`
            SELECT
              organization.id AS workspace_id,
              organization.name AS display_name,
              organization.slug AS short_name,
              organization.lifecycleState AS lifecycle_state,
              organization.profileRevision AS profile_revision,
              member.userId AS user_id,
              member.role
            FROM member
            INNER JOIN organization ON organization.id = member.organizationId
            WHERE member.userId = ${userId}
            ORDER BY organization.id
            LIMIT 2
          `.pipe(
          Effect.catchTag("SqlError", (cause) =>
            Effect.fail(unavailable("settings.workspace.findByUser")(cause)),
          ),
        );
        const decodedRows = yield* Schema.decodeUnknownEffect(
          Schema.Array(WorkspaceMembershipRow),
        )(rows);
        if (decodedRows.length > 1) {
          settingsPersistenceLogger.error(
            "Workspace membership invariant was violated.",
            {
              event: "workspace_membership_invariant_failed",
              userId,
            },
          );
          return yield* new SettingsMembershipInvariantViolation();
        }
        return Option.fromNullishOr(
          decodedRows[0] === undefined
            ? undefined
            : yield* membershipFrom(decodedRows[0]),
        );
      });

      const workspaceExists = (shortName: WorkspaceShortName) =>
        Effect.tryPromise({
          try: () =>
            db
              .prepare(
                "SELECT id FROM organization WHERE slug = ? COLLATE NOCASE",
              )
              .bind(shortName)
              .first(),
          catch: unavailable("settings.workspace.detectConflict"),
        });

      return WorkspaceRepository.of({
        findByUser,
        createOwnedByUser: Effect.fn("WorkspaceRepository.createOwnedByUser")(
          function* (userId, input) {
            if (Option.isSome(yield* findByUser(userId))) {
              return yield* new WorkspaceMembershipExists();
            }
            if ((yield* workspaceExists(input.shortName)) !== null) {
              return yield* new WorkspaceShortNameUnavailable();
            }
            const workspaceId = crypto.randomUUID();
            const memberId = crypto.randomUUID();
            const now = Date.now();
            const write = Effect.tryPromise({
              try: () =>
                db.batch([
                  db
                    .prepare(
                      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)",
                    )
                    .bind(workspaceId, input.displayName, input.shortName, now),
                  db
                    .prepare(
                      "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, 'owner', ?)",
                    )
                    .bind(memberId, workspaceId, userId, now),
                ]),
              catch: unavailable("settings.workspace.createOwnedByUser"),
            }).pipe(
              Effect.catchTag("PersistenceUnavailable", (cause) =>
                Effect.gen(function* () {
                  if (Option.isSome(yield* findByUser(userId))) {
                    return yield* new WorkspaceMembershipExists();
                  }
                  if ((yield* workspaceExists(input.shortName)) !== null) {
                    return yield* new WorkspaceShortNameUnavailable();
                  }
                  return yield* cause;
                }),
              ),
            );
            yield* write;
            settingsPersistenceLogger.info("Workspace creation succeeded.", {
              event: "workspace_persistence_created",
              userId,
              workspaceId,
            });
            return yield* Schema.decodeUnknownEffect(WorkspaceMembership)({
              workspace: {
                id: workspaceId,
                displayName: input.displayName,
                shortName: input.shortName,
                lifecycleState: "active",
                revision: 0,
              },
              userId,
              role: "owner",
            });
          },
        ),
        updateProfile: Effect.fn("WorkspaceRepository.updateProfile")(
          function* (workspaceId, input, expectedRevision) {
            const update = Effect.tryPromise({
              try: () =>
                db
                  .prepare(
                    `UPDATE organization
                     SET name = ?, slug = ?, profileRevision = profileRevision + 1
                     WHERE id = ? AND profileRevision = ?
                     RETURNING
                       id AS workspace_id,
                       name AS display_name,
                       slug AS short_name,
                       lifecycleState AS lifecycle_state,
                       profileRevision AS profile_revision`,
                  )
                  .bind(
                    input.displayName,
                    input.shortName,
                    workspaceId,
                    expectedRevision,
                  )
                  .all(),
              catch: unavailable("settings.workspace.updateProfile"),
            }).pipe(
              Effect.catchTag("PersistenceUnavailable", (cause) =>
                Effect.gen(function* () {
                  const conflict = yield* workspaceExists(input.shortName);
                  if (conflict !== null && conflict.id !== workspaceId) {
                    return yield* new WorkspaceShortNameUnavailable();
                  }
                  return yield* cause;
                }),
              ),
            );
            const result = yield* update;
            const rows = yield* Schema.decodeUnknownEffect(
              Schema.Array(WorkspaceProfileRow),
            )(result.results);
            const row = rows[0];
            if (row === undefined) {
              const current = yield* Effect.tryPromise({
                try: () =>
                  db
                    .prepare(
                      "SELECT profileRevision FROM organization WHERE id = ?",
                    )
                    .bind(workspaceId)
                    .first<{ profileRevision: number }>(),
                catch: unavailable("settings.workspace.classifyProfileMiss"),
              });
              if (current === null) return yield* new WorkspaceNotFound();
              return yield* new WorkspaceProfileConflict({
                currentRevision: current.profileRevision,
              });
            }
            settingsPersistenceLogger.info(
              "Workspace profile update succeeded.",
              {
                event: "workspace_persistence_updated",
                workspaceId,
              },
            );
            return yield* profileFrom(row);
          },
        ),
      });
    }),
  );
