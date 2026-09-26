import {
  decodeExternalApiApplicationAuditPageCursor,
  decodeExternalApiApplicationPageCursor,
  encodeExternalApiApplicationAuditPageCursor,
  encodeExternalApiApplicationPageCursor,
  ExternalApiApplication,
  ExternalApiApplicationAuditEvent,
  type ExternalApiApplicationAuditEventId,
  type ExternalApiApplicationId,
  ExternalApiApplicationNotFound,
  ExternalApiApplicationRepository,
  ExternalApiApplicationScopes,
  PersistenceUnavailable,
} from "@dx/domain";
import { Effect, Layer, Option, Schema } from "effect";
import { settingsPersistenceLogger } from "../../logging.js";

const ApplicationRow = Schema.Struct({
  id: Schema.String,
  workspace_id: Schema.String,
  owner_user_id: Schema.String,
  owner_name: Schema.String,
  owner_email: Schema.String,
  owner_active: Schema.Number,
  client_id: Schema.String,
  name: Schema.String,
  status: Schema.String,
  scopes: Schema.String,
  rate_limit_per_minute: Schema.Number,
  credential_id: Schema.String,
  credential_identifier: Schema.String,
  credential_created_at: Schema.Number,
  credential_expires_at: Schema.NullOr(Schema.Number),
  created_at: Schema.Number,
  updated_at: Schema.Number,
  last_used_at: Schema.NullOr(Schema.Number),
});

type ApplicationRow = typeof ApplicationRow.Type;

const AuditRow = Schema.Struct({
  id: Schema.String,
  application_id: Schema.String,
  actor_type: Schema.String,
  actor_id: Schema.String,
  action: Schema.String,
  outcome: Schema.String,
  request_id: Schema.String,
  credential_id: Schema.NullOr(Schema.String),
  scope: Schema.NullOr(Schema.String),
  http_method: Schema.NullOr(Schema.String),
  http_path: Schema.NullOr(Schema.String),
  created_at: Schema.Number,
});

const AuthenticatedRow = Schema.Struct({
  application_id: Schema.String,
  workspace_id: Schema.String,
  owner_user_id: Schema.String,
  client_id: Schema.String,
  credential_id: Schema.String,
  scopes: Schema.String,
  rate_limit_per_minute: Schema.Number,
});

const iso = (milliseconds: number) => new Date(milliseconds).toISOString();

const applicationSelect = `
  SELECT
    application.id,
    application.workspace_id,
    application.owner_user_id,
    COALESCE(personal_account.display_name, owner.name) AS owner_name,
    owner.email AS owner_email,
    CASE WHEN active_member.id IS NULL THEN 0 ELSE 1 END AS owner_active,
    application.client_id,
    application.name,
    application.status,
    application.scopes,
    application.rate_limit_per_minute,
    credential.id AS credential_id,
    credential.identifier AS credential_identifier,
    credential.created_at AS credential_created_at,
    credential.expires_at AS credential_expires_at,
    application.created_at,
    application.updated_at,
    application.last_used_at
  FROM external_api_application AS application
  INNER JOIN "user" AS owner ON owner.id = application.owner_user_id
  LEFT JOIN personal_account ON personal_account.user_id = owner.id
  LEFT JOIN member AS active_member
    ON active_member.organizationId = application.workspace_id
    AND active_member.userId = application.owner_user_id
  INNER JOIN external_api_application_credential AS credential
    ON credential.id = (
      SELECT current_credential.id
      FROM external_api_application_credential AS current_credential
      WHERE current_credential.application_id = application.id
      ORDER BY current_credential.created_at DESC, current_credential.rowid DESC
      LIMIT 1
    )
`;

const applicationFrom = Effect.fn("externalApiApplicationFromRow")(function* (
  row: ApplicationRow,
) {
  const scopes = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(ExternalApiApplicationScopes),
  )(row.scopes);
  return yield* Schema.decodeUnknownEffect(ExternalApiApplication)({
    id: row.id,
    workspaceId: row.workspace_id,
    clientId: row.client_id,
    name: row.name,
    owner: {
      userId: row.owner_user_id,
      name: row.owner_name,
      email: row.owner_email,
      activeMember: row.owner_active === 1,
    },
    status: row.status,
    scopes,
    rateLimitPerMinute: row.rate_limit_per_minute,
    credential: {
      id: row.credential_id,
      identifier: row.credential_identifier,
      createdAt: iso(row.credential_created_at),
      ...(row.credential_expires_at === null
        ? {}
        : { expiresAt: iso(row.credential_expires_at) }),
    },
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(row.last_used_at === null ? {} : { lastUsedAt: iso(row.last_used_at) }),
  });
});

const auditFrom = (row: typeof AuditRow.Type) =>
  Schema.decodeUnknownEffect(ExternalApiApplicationAuditEvent)({
    id: row.id,
    applicationId: row.application_id,
    actorType: row.actor_type,
    actorId: row.actor_id,
    action: row.action,
    outcome: row.outcome,
    requestId: row.request_id,
    ...(row.credential_id === null ? {} : { credentialId: row.credential_id }),
    ...(row.scope === null ? {} : { scope: row.scope }),
    ...(row.http_method === null ? {} : { method: row.http_method }),
    ...(row.http_path === null ? {} : { path: row.http_path }),
    createdAt: iso(row.created_at),
  });

const unavailable = (operation: string) => (cause: unknown) =>
  PersistenceUnavailable.new({ operation }, cause);

const queryApplication = Effect.fn("queryExternalApiApplication")(function* (
  db: D1Database,
  workspaceId: string,
  applicationId: ExternalApiApplicationId,
) {
  const result = yield* Effect.tryPromise({
    try: () =>
      db
        .prepare(
          `${applicationSelect}
           WHERE application.workspace_id = ? AND application.id = ?
           LIMIT 1`,
        )
        .bind(workspaceId, applicationId)
        .first(),
    catch: unavailable("settings.applications.find"),
  });
  if (result === null) return yield* new ExternalApiApplicationNotFound();
  return yield* applicationFrom(
    yield* Schema.decodeUnknownEffect(ApplicationRow)(result),
  );
});

export const ExternalApiApplicationRepositoryD1 = (db: D1Database) =>
  Layer.succeed(
    ExternalApiApplicationRepository,
    ExternalApiApplicationRepository.of({
      list: Effect.fn("ExternalApiApplicationRepository.list")(
        function* (workspaceId, input) {
          const cursor =
            input.cursor === undefined
              ? undefined
              : yield* decodeExternalApiApplicationPageCursor(input.cursor);
          const conditions = ["application.workspace_id = ?"];
          const bindings: Array<string | number> = [workspaceId];
          if (cursor !== undefined) {
            conditions.push(
              "(application.created_at < ? OR (application.created_at = ? AND application.id < ?))",
            );
            bindings.push(cursor.createdAt, cursor.createdAt, cursor.id);
          }
          bindings.push(input.limit + 1);
          const result = yield* Effect.tryPromise({
            try: () =>
              db
                .prepare(
                  `${applicationSelect}
                 WHERE ${conditions.join(" AND ")}
                 ORDER BY application.created_at DESC, application.id DESC
                 LIMIT ?`,
                )
                .bind(...bindings)
                .all(),
            catch: unavailable("settings.applications.list"),
          });
          const rows = yield* Schema.decodeUnknownEffect(
            Schema.Array(ApplicationRow),
          )(result.results);
          const decoded = yield* Effect.all(rows.map(applicationFrom));
          const items = decoded.slice(0, input.limit);
          const last = rows[Math.min(input.limit, rows.length) - 1];
          return {
            items,
            ...(decoded.length > input.limit && last !== undefined
              ? {
                  nextCursor: yield* encodeExternalApiApplicationPageCursor({
                    createdAt: last.created_at,
                    id: last.id as ExternalApiApplicationId,
                  }),
                }
              : {}),
          };
        },
      ),
      findById: (workspaceId, applicationId) =>
        queryApplication(db, workspaceId, applicationId),
      create: Effect.fn("ExternalApiApplicationRepository.create")(
        function* (record) {
          yield* Effect.tryPromise({
            try: () =>
              db.batch([
                db
                  .prepare(
                    `INSERT INTO external_api_application (
                     id, workspace_id, owner_user_id, client_id, name, scopes,
                     rate_limit_per_minute, created_at, updated_at
                   )
                   SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
                   FROM member
                   WHERE organizationId = ? AND userId = ?`,
                  )
                  .bind(
                    record.id,
                    record.workspaceId,
                    record.ownerUserId,
                    record.clientId,
                    record.name,
                    JSON.stringify(record.scopes),
                    record.rateLimitPerMinute,
                    record.now,
                    record.now,
                    record.workspaceId,
                    record.ownerUserId,
                  ),
                db
                  .prepare(
                    `INSERT INTO external_api_application_credential (
                     id, application_id, secret_hash, identifier, created_at
                   )
                   SELECT ?, ?, ?, ?, ?
                   FROM external_api_application
                   WHERE id = ?`,
                  )
                  .bind(
                    record.credentialId,
                    record.id,
                    record.secretHash,
                    record.credentialIdentifier,
                    record.now,
                    record.id,
                  ),
              ]),
            catch: unavailable("settings.applications.create"),
          });
          settingsPersistenceLogger.info("External API application created.", {
            event: "external_api_application_created",
            applicationId: record.id,
            workspaceId: record.workspaceId,
          });
          return yield* queryApplication(db, record.workspaceId, record.id);
        },
      ),
      update: Effect.fn("ExternalApiApplicationRepository.update")(
        function* (workspaceId, applicationId, record) {
          const result = yield* Effect.tryPromise({
            try: () =>
              db
                .prepare(
                  `UPDATE external_api_application
                 SET name = ?, scopes = ?, rate_limit_per_minute = ?, updated_at = ?
                 WHERE id = ? AND workspace_id = ? AND status <> 'revoked'`,
                )
                .bind(
                  record.name,
                  JSON.stringify(record.scopes),
                  record.rateLimitPerMinute,
                  record.now,
                  applicationId,
                  workspaceId,
                )
                .run(),
            catch: unavailable("settings.applications.update"),
          });
          if (result.meta.changes === 0) {
            return yield* new ExternalApiApplicationNotFound();
          }
          return yield* queryApplication(db, workspaceId, applicationId);
        },
      ),
      rotateCredential: Effect.fn(
        "ExternalApiApplicationRepository.rotateCredential",
      )(function* (workspaceId, applicationId, record) {
        const existing = yield* queryApplication(
          db,
          workspaceId,
          applicationId,
        );
        if (existing.status !== "active") {
          return yield* new ExternalApiApplicationNotFound();
        }
        yield* Effect.tryPromise({
          try: () =>
            db.batch([
              db
                .prepare(
                  `UPDATE external_api_application_credential
                   SET revoked_at = ?
                   WHERE application_id = ? AND revoked_at IS NULL
                     AND expires_at IS NOT NULL`,
                )
                .bind(record.now, applicationId),
              db
                .prepare(
                  `UPDATE external_api_application_credential
                   SET expires_at = ?
                   WHERE application_id = ? AND revoked_at IS NULL
                     AND expires_at IS NULL`,
                )
                .bind(record.previousExpiresAt, applicationId),
              db
                .prepare(
                  `INSERT INTO external_api_application_credential (
                     id, application_id, secret_hash, identifier, created_at
                   ) VALUES (?, ?, ?, ?, ?)`,
                )
                .bind(
                  record.credentialId,
                  applicationId,
                  record.secretHash,
                  record.credentialIdentifier,
                  record.now,
                ),
              db
                .prepare(
                  `UPDATE external_api_application
                   SET updated_at = ?
                   WHERE id = ? AND workspace_id = ? AND status = 'active'`,
                )
                .bind(record.now, applicationId, workspaceId),
            ]),
          catch: unavailable("settings.applications.rotate"),
        });
        return yield* queryApplication(db, workspaceId, applicationId);
      }),
      setStatus: Effect.fn("ExternalApiApplicationRepository.setStatus")(
        function* (workspaceId, applicationId, status, now) {
          const result = yield* Effect.tryPromise({
            try: () =>
              db.batch([
                db
                  .prepare(
                    `UPDATE external_api_application
                     SET status = ?, updated_at = ?,
                       revoked_at = CASE WHEN ? = 'revoked' THEN ? ELSE NULL END
                     WHERE id = ? AND workspace_id = ?
                       AND (status <> 'revoked' OR ? = 'revoked')`,
                  )
                  .bind(
                    status,
                    now,
                    status,
                    now,
                    applicationId,
                    workspaceId,
                    status,
                  ),
                db
                  .prepare(
                    `UPDATE external_api_application_credential
                     SET revoked_at = ?
                     WHERE application_id = ? AND ? = 'revoked'
                       AND revoked_at IS NULL`,
                  )
                  .bind(now, applicationId, status),
              ]),
            catch: unavailable("settings.applications.setStatus"),
          });
          if (result[0]?.meta.changes === 0) {
            return yield* new ExternalApiApplicationNotFound();
          }
          return yield* queryApplication(db, workspaceId, applicationId);
        },
      ),
      authenticate: Effect.fn("ExternalApiApplicationRepository.authenticate")(
        function* (clientId, secretHash, now) {
          const result = yield* Effect.tryPromise({
            try: () =>
              db
                .prepare(
                  `SELECT
                     application.id AS application_id,
                     application.workspace_id,
                     application.owner_user_id,
                     application.client_id,
                     credential.id AS credential_id,
                     application.scopes,
                     application.rate_limit_per_minute
                   FROM external_api_application AS application
                   INNER JOIN organization
                     ON organization.id = application.workspace_id
                     AND organization.lifecycleState = 'active'
                   INNER JOIN member
                     ON member.organizationId = application.workspace_id
                     AND member.userId = application.owner_user_id
                   INNER JOIN external_api_application_credential AS credential
                     ON credential.application_id = application.id
                   WHERE application.client_id = ?
                     AND application.status = 'active'
                     AND credential.secret_hash = ?
                     AND credential.revoked_at IS NULL
                     AND (credential.expires_at IS NULL OR credential.expires_at > ?)
                   LIMIT 1`,
                )
                .bind(clientId, secretHash, now)
                .first(),
            catch: unavailable("settings.applications.authenticate"),
          });
          if (result === null) return Option.none();
          const row =
            yield* Schema.decodeUnknownEffect(AuthenticatedRow)(result);
          const scopes = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(ExternalApiApplicationScopes),
          )(row.scopes);
          return Option.some({
            applicationId: row.application_id as never,
            workspaceId: row.workspace_id as never,
            ownerUserId: row.owner_user_id as never,
            clientId: row.client_id as never,
            credentialId: row.credential_id as never,
            scopes,
            rateLimitPerMinute: row.rate_limit_per_minute as never,
          });
        },
      ),
      claimRateLimit: Effect.fn(
        "ExternalApiApplicationRepository.claimRateLimit",
      )(function* (applicationId, maximum, windowStartedAt) {
        const row = yield* Effect.tryPromise({
          try: () =>
            db
              .prepare(
                `INSERT INTO external_api_application_rate_limit (
                   application_id, window_started_at, request_count
                 ) VALUES (?, ?, 1)
                 ON CONFLICT(application_id) DO UPDATE SET
                   window_started_at = CASE
                     WHEN window_started_at < excluded.window_started_at
                     THEN excluded.window_started_at
                     ELSE window_started_at
                   END,
                   request_count = CASE
                     WHEN window_started_at < excluded.window_started_at THEN 1
                     ELSE request_count + 1
                   END
                 WHERE window_started_at < excluded.window_started_at
                   OR request_count < ?
                 RETURNING request_count`,
              )
              .bind(applicationId, windowStartedAt, maximum)
              .first(),
          catch: unavailable("settings.applications.rateLimit"),
        });
        return row !== null;
      }),
      touchLastUsed: Effect.fn(
        "ExternalApiApplicationRepository.touchLastUsed",
      )(function* (applicationId, now) {
        yield* Effect.tryPromise({
          try: () =>
            db
              .prepare(
                `UPDATE external_api_application
                 SET last_used_at = ?, updated_at = updated_at
                 WHERE id = ?`,
              )
              .bind(now, applicationId)
              .run(),
          catch: unavailable("settings.applications.touchLastUsed"),
        });
      }),
      recordAudit: Effect.fn("ExternalApiApplicationRepository.recordAudit")(
        function* (record) {
          yield* Effect.tryPromise({
            try: () =>
              db
                .prepare(
                  `INSERT INTO external_api_application_audit (
                     id, application_id, workspace_id, actor_type, actor_id,
                     action, outcome, request_id, credential_id, scope,
                     http_method, http_path, created_at
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                )
                .bind(
                  record.id,
                  record.applicationId,
                  record.workspaceId,
                  record.actorType,
                  record.actorId,
                  record.action,
                  record.outcome,
                  record.requestId,
                  record.credentialId ?? null,
                  record.scope ?? null,
                  record.method ?? null,
                  record.path ?? null,
                  record.createdAt,
                )
                .run(),
            catch: unavailable("settings.applications.audit"),
          });
        },
      ),
      listAudit: Effect.fn("ExternalApiApplicationRepository.listAudit")(
        function* (workspaceId, applicationId, input) {
          yield* queryApplication(db, workspaceId, applicationId);
          const cursor =
            input.cursor === undefined
              ? undefined
              : yield* decodeExternalApiApplicationAuditPageCursor(
                  input.cursor,
                );
          const conditions = ["workspace_id = ?", "application_id = ?"];
          const bindings: Array<string | number> = [workspaceId, applicationId];
          if (cursor !== undefined) {
            conditions.push("(created_at < ? OR (created_at = ? AND id < ?))");
            bindings.push(cursor.createdAt, cursor.createdAt, cursor.id);
          }
          bindings.push(input.limit + 1);
          const result = yield* Effect.tryPromise({
            try: () =>
              db
                .prepare(
                  `SELECT
                     id, application_id, actor_type, actor_id, action, outcome,
                     request_id, credential_id, scope, http_method, http_path,
                     created_at
                   FROM external_api_application_audit
                   WHERE ${conditions.join(" AND ")}
                   ORDER BY created_at DESC, id DESC
                   LIMIT ?`,
                )
                .bind(...bindings)
                .all(),
            catch: unavailable("settings.applications.listAudit"),
          });
          const rows = yield* Schema.decodeUnknownEffect(
            Schema.Array(AuditRow),
          )(result.results);
          const decoded = yield* Effect.all(rows.map(auditFrom));
          const items = decoded.slice(0, input.limit);
          const last = rows[Math.min(input.limit, rows.length) - 1];
          return {
            items,
            ...(decoded.length > input.limit && last !== undefined
              ? {
                  nextCursor:
                    yield* encodeExternalApiApplicationAuditPageCursor({
                      createdAt: last.created_at,
                      id: last.id as ExternalApiApplicationAuditEventId,
                    }),
                }
              : {}),
          };
        },
      ),
    }),
  );
