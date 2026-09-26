import {
  decodeProjectPageCursor,
  encodeProjectPageCursor,
  type InvalidPageCursor,
  PersistenceUnavailable,
  PROJECTLESS_PROJECT_NAME,
  Project,
  ProjectId,
  ProjectNameConflict,
  ProjectNotFound,
  ProjectRepository,
  ProjectSourceAuthority,
} from "@dx/domain";
import { D1Client } from "@effect/sql-d1";
import { DateTime, Effect, Layer, Match, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { projectPersistenceLogger } from "../logging.js";

const ProjectRow = Schema.Struct({
  id: Schema.String,
  owner_user_id: Schema.String,
  workspace_id: Schema.NullOr(Schema.String),
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  icon_key: Schema.NullOr(Schema.String),
  revision: Schema.Number,
  repository_provider: Schema.NullOr(Schema.String),
  repository_binding_revision: Schema.NullOr(Schema.Number),
  repository_full_name: Schema.NullOr(Schema.String),
  repository_web_url: Schema.NullOr(Schema.String),
  repository_clone_url: Schema.NullOr(Schema.String),
  ship_action: Schema.String,
  commit_author_preference: Schema.String,
  commit_author_name: Schema.String,
  commit_author_email: Schema.String,
  signing_preference: Schema.String,
  runner_profile_id: Schema.String,
  public_code_enabled: Schema.Number,
  created_at: Schema.String,
  updated_at: Schema.String,
});

type ProjectRow = typeof ProjectRow.Type;
type ProjectObservationError =
  | InvalidPageCursor
  | PersistenceUnavailable
  | ProjectNameConflict
  | ProjectNotFound
  | Schema.SchemaError;

const decodeProjectRows = (rows: ReadonlyArray<unknown>) =>
  Schema.decodeUnknownEffect(Schema.Array(ProjectRow))(rows).pipe(
    Effect.flatMap((decoded) =>
      Effect.all(
        decoded.map((row) =>
          Schema.decodeUnknownEffect(Project)({
            id: row.id,
            ownerUserId: row.owner_user_id,
            ...(row.workspace_id === null
              ? {}
              : { workspaceId: row.workspace_id }),
            name: row.name,
            ...(row.description === null
              ? {}
              : { description: row.description }),
            ...(row.icon_key === null ? {} : { iconKey: row.icon_key }),
            ...(row.repository_provider === null ||
            row.repository_binding_revision === null ||
            row.repository_full_name === null ||
            row.repository_web_url === null
              ? {}
              : {
                  repository: {
                    provider: row.repository_provider,
                    bindingRevision: row.repository_binding_revision,
                    fullName: row.repository_full_name,
                    webUrl: row.repository_web_url,
                    ...(row.repository_clone_url === null
                      ? {}
                      : { cloneUrl: row.repository_clone_url }),
                  },
                }),
            revision: row.revision,
            configuration: {
              shipAction: row.ship_action,
              commitAuthor: {
                preference: row.commit_author_preference,
                name: row.commit_author_name,
                email: row.commit_author_email,
              },
              signingPreference: row.signing_preference,
              runnerProfileId: row.runner_profile_id,
              publicCodeEnabled: row.public_code_enabled === 1,
            },
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          }),
        ),
      ),
    ),
  );

const logFailure = (
  error: ProjectObservationError,
  operation: string,
  properties: Record<string, unknown>,
  startedAt: number,
) => {
  const details = {
    operation,
    outcome: error._tag,
    durationMs: Math.round(performance.now() - startedAt),
    ...properties,
  };
  Match.value(error).pipe(
    Match.tag("ProjectNotFound", () =>
      projectPersistenceLogger.info("Project lookup found no match.", details),
    ),
    Match.tag("InvalidPageCursor", () =>
      projectPersistenceLogger.warn(
        "Project persistence rejected invalid input.",
        details,
      ),
    ),
    Match.orElse(() =>
      projectPersistenceLogger.error("Project persistence failed.", details),
    ),
  );
};

const observe = <A, E extends ProjectObservationError, R>(
  operation: string,
  properties: Record<string, unknown>,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.suspend(() => {
    const startedAt = performance.now();
    return effect.pipe(
      Effect.tap(() =>
        Effect.sync(() =>
          projectPersistenceLogger.info("Project persistence succeeded.", {
            operation,
            outcome: "success",
            durationMs: Math.round(performance.now() - startedAt),
            ...properties,
          }),
        ),
      ),
      Effect.tapError((error) =>
        Effect.sync(() => logFailure(error, operation, properties, startedAt)),
      ),
    );
  });

export const ProjectRepositoryD1 = Layer.effect(
  ProjectRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const d1: D1Client.D1Client = yield* D1Client.D1Client;
    const unavailable = (operation: string) => (cause: unknown) =>
      PersistenceUnavailable.new({ operation }, cause);
    const nameConflictOrUnavailable = (operation: string) => (cause: unknown) =>
      String(cause).includes("UNIQUE constraint failed: projects.")
        ? new ProjectNameConflict()
        : unavailable(operation)(cause);

    return ProjectRepository.of({
      ensureProjectless: (ownerUserId, snapshot) =>
        observe(
          "project.ensureProjectless",
          {},
          Effect.gen(function* () {
            const id = yield* Schema.decodeUnknownEffect(ProjectId)(
              `prj_${crypto.randomUUID()}`,
            ).pipe(
              Effect.mapError((cause) =>
                PersistenceUnavailable.new(
                  { operation: "project.ensureProjectless.id" },
                  cause,
                ),
              ),
            );
            const now = new Date().toISOString();
            const configuration = snapshot.configuration;
            yield* sql`
              INSERT OR IGNORE INTO projects (
                id, owner_user_id, workspace_id, name,
                ship_action, commit_author_preference,
                commit_author_name, commit_author_email,
                signing_preference, runner_profile_id, public_code_enabled,
                created_at, updated_at
              ) VALUES (
                ${id}, ${ownerUserId}, ${snapshot.workspaceId ?? null},
                ${PROJECTLESS_PROJECT_NAME},
                ${configuration.shipAction},
                ${configuration.commitAuthor.preference},
                ${configuration.commitAuthor.name},
                ${configuration.commitAuthor.email},
                ${configuration.signingPreference},
                ${configuration.runnerProfileId},
                ${configuration.publicCodeEnabled ? 1 : 0},
                ${now}, ${now}
              )
            `.pipe(
              Effect.catchTag("SqlError", (cause) =>
                Effect.fail(
                  unavailable("project.ensureProjectless.insert")(cause),
                ),
              ),
            );
            const rows = yield* sql<{ readonly id: string }>`
              SELECT id FROM projects
              WHERE owner_user_id = ${ownerUserId}
                AND name = ${PROJECTLESS_PROJECT_NAME}
                AND workspace_id IS ${snapshot.workspaceId ?? null}
              LIMIT 1
            `.pipe(
              Effect.catchTag("SqlError", (cause) =>
                Effect.fail(
                  unavailable("project.ensureProjectless.read")(cause),
                ),
              ),
            );
            return yield* Schema.decodeUnknownEffect(ProjectId)(
              rows[0]?.id,
            ).pipe(
              Effect.mapError((cause) =>
                PersistenceUnavailable.new(
                  { operation: "project.ensureProjectless.decode" },
                  cause,
                ),
              ),
            );
          }),
        ),
      insert: (project, authority) =>
        observe(
          "project.insert",
          { projectId: project.id },
          Schema.encodeEffect(Project)(project).pipe(
            Effect.flatMap((encoded) => {
              const projectInsert = sql`
                INSERT INTO projects (
                  id, owner_user_id, workspace_id, name, description, icon_key, revision,
                  ship_action, commit_author_preference,
                  commit_author_name, commit_author_email,
                  signing_preference, runner_profile_id, public_code_enabled,
                  created_at, updated_at
                )
                VALUES (
                  ${encoded.id}, ${encoded.ownerUserId},
                  ${encoded.workspaceId ?? null}, ${encoded.name}, ${encoded.description ?? null},
                  ${encoded.iconKey ?? null}, ${encoded.revision},
                  ${encoded.configuration.shipAction},
                  ${encoded.configuration.commitAuthor.preference},
                  ${encoded.configuration.commitAuthor.name},
                  ${encoded.configuration.commitAuthor.email},
                  ${encoded.configuration.signingPreference},
                  ${encoded.configuration.runnerProfileId},
                  ${encoded.configuration.publicCodeEnabled ? 1 : 0},
                  ${encoded.createdAt}, ${encoded.updatedAt}
                )
              `;
              if (project.repository === undefined) {
                return d1.batch([projectInsert] as const).pipe(Effect.asVoid);
              }
              const repositoryInsert = sql`
                INSERT INTO project_repository (
                  project_id, provider, binding_revision, full_name, web_url,
                  clone_url, created_at, updated_at
                ) VALUES (
                  ${project.id}, ${project.repository.provider},
                  ${project.repository.bindingRevision}, ${project.repository.fullName},
                  ${project.repository.webUrl}, ${project.repository.cloneUrl ?? null},
                  ${encoded.createdAt}, ${encoded.updatedAt}
                )
              `;
              if (authority === undefined)
                return d1
                  .batch([projectInsert, repositoryInsert] as const)
                  .pipe(Effect.asVoid);
              return Schema.encodeEffect(ProjectSourceAuthority)(
                authority,
              ).pipe(
                Effect.flatMap((authority) =>
                  d1.batch([
                    projectInsert,
                    repositoryInsert,
                    sql`
                    INSERT INTO project_source_authority (
                      project_id, provider, owner_scope, owner_id, owner_grant_id,
                      installation_id, provider_workspace_id, provider_repository_id, binding_revision,
                      provenance, default_branch, source_health, source_health_reason,
                      authorization_epoch, installation_epoch, policy_revision,
                      created_at, updated_at
                    ) SELECT
                      ${project.id}, ${authority.provider}, ${authority.ownerScope},
                      ${authority.ownerId}, ${authority.grantId ?? null},
                      ${authority.installationId ?? null}, ${authority.providerWorkspaceId ?? null},
                      ${authority.providerRepositoryId},
                      ${authority.bindingRevision}, ${authority.provenance},
                      ${authority.defaultBranch ?? null}, ${authority.health.state},
                      ${authority.health.reason ?? null}, ${authority.authorizationEpoch},
                      ${authority.installationEpoch}, ${authority.policyRevision},
                      ${encoded.createdAt}, ${encoded.updatedAt}
                    WHERE ${authority.provenance} = 'legacy'
                       OR (${authority.provider} = 'github' AND EXISTS (
                         SELECT 1 FROM github_owner_grant AS grant_row
                         JOIN github_installation AS installation
                           ON installation.installation_id = grant_row.installation_id
                         JOIN github_installation_repository AS entitlement
                           ON entitlement.installation_id = grant_row.installation_id
                          AND entitlement.provider_repository_id = ${authority.providerRepositoryId}
                         WHERE grant_row.id = ${authority.grantId ?? null}
                           AND grant_row.owner_scope = ${authority.ownerScope}
                           AND grant_row.owner_id = ${authority.ownerId}
                           AND grant_row.status = 'active' AND installation.status = 'active'
                           AND entitlement.entitled = 1
                           AND COALESCE((SELECT epoch FROM github_authorization_epoch
                             WHERE subject_kind = 'owner-grant' AND subject_id = grant_row.id), 1)
                             = ${authority.authorizationEpoch}
                           AND COALESCE((SELECT epoch FROM github_authorization_epoch
                             WHERE subject_kind = 'installation'
                               AND subject_id = grant_row.installation_id), 1)
                             = ${authority.installationEpoch}
                           AND CASE WHEN grant_row.owner_scope = 'workspace'
                             THEN COALESCE((SELECT revision FROM workspace_policy
                               WHERE workspace_id = grant_row.owner_id), 0) ELSE 0 END
                             = ${authority.policyRevision}
                       ))
                       OR (${authority.provider} = 'bitbucket'
                         AND ${authority.ownerScope} = 'personal'
                         AND ${authority.installationId ?? null} IS NULL
                         AND ${authority.installationEpoch} = 0
                         AND ${authority.policyRevision} = 0
                         AND EXISTS (
                           SELECT 1 FROM bitbucket_connection AS connection
                           JOIN bitbucket_repository AS entitlement
                             ON entitlement.connection_id = connection.id
                            AND entitlement.repository_id = ${authority.providerRepositoryId}
                            AND entitlement.workspace_id = ${authority.providerWorkspaceId ?? null}
                          WHERE connection.id = ${authority.grantId ?? null}
                            AND connection.user_id = ${authority.ownerId}
                            AND connection.status = 'active'
                            AND connection.authorization_epoch = ${authority.authorizationEpoch}
                         ))
                  `,
                    sql`
                    INSERT INTO source_admission_assertion (project_id)
                    VALUES ((SELECT project_id FROM project_source_authority WHERE project_id = ${project.id}))
                  `,
                    sql`
                    DELETE FROM source_admission_assertion WHERE project_id = ${project.id}
                  `,
                  ] as const),
                ),
                Effect.asVoid,
              );
            }),
            Effect.catchTag("SqlError", (cause) =>
              Effect.fail(nameConflictOrUnavailable("project.insert")(cause)),
            ),
          ),
        ),

      findOwnedById: (projectId, ownerUserId) =>
        observe(
          "project.findOwnedById",
          { projectId },
          sql<ProjectRow>`
            SELECT * FROM project_read_model
            WHERE id = ${projectId} AND owner_user_id = ${ownerUserId}
          `.pipe(
            Effect.catchTag("SqlError", (cause) =>
              Effect.fail(unavailable("project.findOwnedById")(cause)),
            ),
            Effect.flatMap(decodeProjectRows),
            Effect.flatMap((projects) =>
              projects[0] === undefined
                ? Effect.fail(new ProjectNotFound({ projectId }))
                : Effect.succeed(projects[0]),
            ),
          ),
        ),

      listOwned: (ownerUserId, request) =>
        observe(
          "project.listOwned",
          {},
          Effect.gen(function* () {
            const limit = request.limit ?? 20;
            const cursor = request.cursor
              ? yield* decodeProjectPageCursor(request.cursor)
              : undefined;
            const cursorTime = cursor
              ? Schema.encodeSync(Schema.DateTimeUtcFromString)(
                  cursor.createdAt,
                )
              : undefined;
            const rows = yield* (
              cursor
                ? sql<ProjectRow>`
                  SELECT * FROM project_read_model
                  WHERE owner_user_id = ${ownerUserId}
                    AND name != ${PROJECTLESS_PROJECT_NAME}
                    AND (created_at, id) < (${cursorTime}, ${cursor.id})
                  ORDER BY created_at DESC, id DESC
                  LIMIT ${limit + 1}
                `
                : sql<ProjectRow>`
                  SELECT * FROM project_read_model
                  WHERE owner_user_id = ${ownerUserId}
                    AND name != ${PROJECTLESS_PROJECT_NAME}
                  ORDER BY created_at DESC, id DESC
                  LIMIT ${limit + 1}
                `
            ).pipe(
              Effect.catchTag("SqlError", (cause) =>
                Effect.fail(unavailable("project.listOwned")(cause)),
              ),
            );
            const decoded = yield* decodeProjectRows(rows);
            const items = decoded.slice(0, limit);
            const last = items.at(-1);
            const nextCursor =
              decoded.length > limit && last
                ? yield* encodeProjectPageCursor({
                    createdAt: last.createdAt,
                    id: last.id,
                  })
                : undefined;
            return { items, nextCursor };
          }),
        ),

      updateOwned: (projectId, ownerUserId, revision, update) =>
        observe(
          "project.updateOwned",
          { projectId },
          Effect.gen(function* () {
            const current = yield* sql<ProjectRow>`
              SELECT * FROM project_read_model
              WHERE id = ${projectId} AND owner_user_id = ${ownerUserId}
                AND name != ${PROJECTLESS_PROJECT_NAME}
            `.pipe(
              Effect.catchTag("SqlError", (cause) =>
                Effect.fail(unavailable("project.updateOwned.read")(cause)),
              ),
              Effect.flatMap(decodeProjectRows),
              Effect.flatMap((projects) =>
                projects[0] === undefined
                  ? Effect.fail(new ProjectNotFound({ projectId }))
                  : Effect.succeed(projects[0]),
              ),
            );
            if (current.revision !== revision) {
              return yield* new ProjectNotFound({ projectId });
            }
            const now = yield* DateTime.now;
            const next = yield* Schema.decodeUnknownEffect(
              Schema.toType(Project),
            )({
              ...current,
              ...update,
              revision: revision + 1,
              updatedAt: now,
            });
            const encoded = yield* Schema.encodeEffect(Project)(next);
            const updated = yield* sql<{ readonly id: string }>`
              UPDATE projects SET
                name = ${encoded.name}, description = ${encoded.description ?? null},
                icon_key = ${encoded.iconKey ?? null}, revision = ${encoded.revision},
                ship_action = ${encoded.configuration.shipAction},
                commit_author_preference = ${encoded.configuration.commitAuthor.preference},
                commit_author_name = ${encoded.configuration.commitAuthor.name},
                commit_author_email = ${encoded.configuration.commitAuthor.email},
                signing_preference = ${encoded.configuration.signingPreference},
                runner_profile_id = ${encoded.configuration.runnerProfileId},
                public_code_enabled = ${encoded.configuration.publicCodeEnabled ? 1 : 0},
                updated_at = ${encoded.updatedAt}
              WHERE id = ${projectId} AND owner_user_id = ${ownerUserId} AND revision = ${revision}
              RETURNING id
            `.pipe(
              Effect.catchTag("SqlError", (cause) =>
                Effect.fail(
                  nameConflictOrUnavailable("project.updateOwned.write")(cause),
                ),
              ),
            );
            if (updated.length !== 1) {
              return yield* new ProjectNotFound({ projectId });
            }
            return next;
          }),
        ),

      rebindRepositoryOwned: (
        projectId,
        ownerUserId,
        revision,
        repository,
        unsafeAuthority,
      ) =>
        observe(
          "project.rebindRepositoryOwned",
          { projectId },
          Effect.gen(function* () {
            const mutable = yield* sql<{ readonly id: string }>`
              SELECT id FROM projects
              WHERE id = ${projectId} AND owner_user_id = ${ownerUserId}
                AND revision = ${revision}
                AND name != ${PROJECTLESS_PROJECT_NAME}
            `.pipe(
              Effect.catchTag("SqlError", (cause) =>
                Effect.fail(
                  unavailable("project.rebindRepositoryOwned.preflight")(cause),
                ),
              ),
            );
            if (mutable.length !== 1) {
              return yield* new ProjectNotFound({ projectId });
            }
            const now = yield* DateTime.now;
            const updatedAt = Schema.encodeSync(Schema.DateTimeUtcFromString)(
              now,
            );
            const authority = yield* Schema.encodeEffect(
              ProjectSourceAuthority,
            )(unsafeAuthority);
            yield* d1
              .batch([
                sql`
                  DELETE FROM project_source_authority
                  WHERE project_id = ${projectId}
                `,
                sql`
                  INSERT INTO project_repository (
                    project_id, provider, binding_revision, full_name, web_url,
                    clone_url, created_at, updated_at
                  ) SELECT
                    ${projectId}, ${repository.provider}, ${repository.bindingRevision},
                    ${repository.fullName},
                    ${repository.webUrl}, ${repository.cloneUrl ?? null},
                    ${updatedAt}, ${updatedAt}
                  WHERE EXISTS (SELECT 1 FROM projects WHERE id = ${projectId})
                  ON CONFLICT(project_id) DO UPDATE SET
                    provider = excluded.provider,
                    binding_revision = excluded.binding_revision,
                    full_name = excluded.full_name, web_url = excluded.web_url,
                    clone_url = excluded.clone_url, updated_at = excluded.updated_at
                `,
                sql`
                  INSERT INTO project_source_authority (
                    project_id, provider, owner_scope, owner_id, owner_grant_id,
                    installation_id, provider_workspace_id, provider_repository_id, binding_revision,
                    provenance, default_branch, source_health, source_health_reason,
                    authorization_epoch, installation_epoch, policy_revision,
                    created_at, updated_at
                  ) SELECT
                    ${projectId}, ${authority.provider}, ${authority.ownerScope},
                    ${authority.ownerId}, ${authority.grantId ?? null},
                    ${authority.installationId ?? null}, ${authority.providerWorkspaceId ?? null},
                    ${authority.providerRepositoryId},
                    ${authority.bindingRevision}, ${authority.provenance},
                    ${authority.defaultBranch ?? null}, ${authority.health.state},
                    ${authority.health.reason ?? null}, ${authority.authorizationEpoch},
                    ${authority.installationEpoch}, ${authority.policyRevision},
                    ${updatedAt}, ${updatedAt}
                  WHERE (${authority.provider} = 'github' AND EXISTS (
                    SELECT 1 FROM github_owner_grant AS grant_row
                    JOIN github_installation AS installation
                      ON installation.installation_id = grant_row.installation_id
                    JOIN github_installation_repository AS entitlement
                      ON entitlement.installation_id = grant_row.installation_id
                     AND entitlement.provider_repository_id = ${authority.providerRepositoryId}
                    WHERE grant_row.id = ${authority.grantId ?? null}
                      AND grant_row.owner_scope = ${authority.ownerScope}
                      AND grant_row.owner_id = ${authority.ownerId}
                      AND grant_row.status = 'active' AND installation.status = 'active'
                      AND entitlement.entitled = 1
                      AND COALESCE((SELECT epoch FROM github_authorization_epoch
                        WHERE subject_kind = 'owner-grant' AND subject_id = grant_row.id), 1)
                        = ${authority.authorizationEpoch}
                      AND COALESCE((SELECT epoch FROM github_authorization_epoch
                        WHERE subject_kind = 'installation'
                          AND subject_id = grant_row.installation_id), 1)
                        = ${authority.installationEpoch}
                      AND CASE WHEN grant_row.owner_scope = 'workspace'
                        THEN COALESCE((SELECT revision FROM workspace_policy
                          WHERE workspace_id = grant_row.owner_id), 0) ELSE 0 END
                        = ${authority.policyRevision}
                  )) OR (${authority.provider} = 'bitbucket'
                    AND ${authority.ownerScope} = 'personal'
                    AND ${authority.installationId ?? null} IS NULL
                    AND ${authority.installationEpoch} = 0
                    AND ${authority.policyRevision} = 0
                    AND EXISTS (
                      SELECT 1 FROM bitbucket_connection AS connection
                      JOIN bitbucket_repository AS entitlement
                        ON entitlement.connection_id = connection.id
                       AND entitlement.repository_id = ${authority.providerRepositoryId}
                       AND entitlement.workspace_id = ${authority.providerWorkspaceId ?? null}
                     WHERE connection.id = ${authority.grantId ?? null}
                       AND connection.user_id = ${authority.ownerId}
                       AND connection.status = 'active'
                       AND connection.authorization_epoch = ${authority.authorizationEpoch}
                    ))
                  ON CONFLICT(project_id) DO UPDATE SET
                    provider = excluded.provider, owner_scope = excluded.owner_scope,
                    owner_id = excluded.owner_id, owner_grant_id = excluded.owner_grant_id,
                    installation_id = excluded.installation_id,
                    provider_workspace_id = excluded.provider_workspace_id,
                    provider_repository_id = excluded.provider_repository_id,
                    binding_revision = excluded.binding_revision,
                    provenance = excluded.provenance,
                    default_branch = excluded.default_branch,
                    source_health = excluded.source_health,
                    source_health_reason = excluded.source_health_reason,
                    authorization_epoch = excluded.authorization_epoch,
                    installation_epoch = excluded.installation_epoch,
                    policy_revision = excluded.policy_revision, updated_at = excluded.updated_at
                `,
                sql`
                  UPDATE projects SET revision = ${revision + 1}, updated_at = ${updatedAt}
                  WHERE id = ${projectId} AND owner_user_id = ${ownerUserId}
                    AND revision = ${revision}
                    AND name != ${PROJECTLESS_PROJECT_NAME}
                `,
                sql`
                  INSERT INTO source_admission_assertion (project_id)
                  VALUES ((SELECT project_id FROM project_source_authority
                    WHERE project_id = ${projectId}
                      AND binding_revision = ${authority.bindingRevision}
                      AND owner_grant_id = ${authority.grantId ?? null}
                      AND provider_repository_id = ${authority.providerRepositoryId}
                      AND changes() = 1))
                `,
                sql`
                  DELETE FROM source_admission_assertion WHERE project_id = ${projectId}
                `,
              ] as const)
              .pipe(
                Effect.catchTag("SqlError", (cause) =>
                  Effect.fail(
                    unavailable("project.rebindRepositoryOwned.write")(cause),
                  ),
                ),
              );
            const rows = yield* sql<ProjectRow>`
              SELECT * FROM project_read_model
              WHERE id = ${projectId} AND owner_user_id = ${ownerUserId}
            `.pipe(
              Effect.catchTag("SqlError", (cause) =>
                Effect.fail(
                  unavailable("project.rebindRepositoryOwned.read")(cause),
                ),
              ),
            );
            const projects = yield* decodeProjectRows(rows);
            return yield* projects[0] === undefined
              ? new ProjectNotFound({ projectId })
              : Effect.succeed(projects[0]);
          }),
        ),
    });
  }),
);
