import {
  EnvironmentVariableId,
  IntegrationConnection,
  IntegrationConnectionNotFound,
  IntegrationOAuthStateInvalid,
  IntegrationRepository,
  IntegrationRepositoryStore,
  integrationCredentialReferenceFor,
  PersistenceUnavailable,
  Timestamp,
  type GitIntegrationProvider,
  type IntegrationOwner,
  type StoredIntegrationOAuthTransaction,
} from "@dx/domain";
import { Effect, Layer, Schema } from "effect";

const ConnectionRow = Schema.Struct({
  id: Schema.String,
  owner_scope: Schema.String,
  owner_id: Schema.String,
  provider: Schema.String,
  status: Schema.String,
  health: Schema.String,
  provider_account_id: Schema.String,
  provider_account_login: Schema.String,
  granted_scopes: Schema.String,
  access_token_reference_id: Schema.NullOr(Schema.String),
  refresh_token_reference_id: Schema.NullOr(Schema.String),
  expires_at: Schema.NullOr(Schema.String),
  refresh_expires_at: Schema.NullOr(Schema.String),
  last_health_check_at: Schema.NullOr(Schema.String),
  revoked_at: Schema.NullOr(Schema.String),
  revocation_status: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.String,
});

const RepositoryRow = Schema.Struct({
  connection_id: Schema.String,
  provider_repository_id: Schema.String,
  full_name: Schema.String,
  web_url: Schema.String,
  clone_url: Schema.String,
  visibility: Schema.String,
  selected: Schema.Number,
  last_authorized_at: Schema.String,
});

const OAuthRow = Schema.Struct({
  id: Schema.String,
  state_hash: Schema.String,
  user_id: Schema.String,
  browser_session_id: Schema.String,
  provider: Schema.String,
  verifier_reference_id: Schema.String,
  callback_url: Schema.String,
  expires_at: Schema.String,
  created_at: Schema.String,
});

const connectionColumns = `
  id, owner_scope, owner_id, provider, status, health,
  provider_account_id, provider_account_login, granted_scopes,
  access_token_reference_id, refresh_token_reference_id, expires_at,
  refresh_expires_at, last_health_check_at, revoked_at, revocation_status,
  created_at, updated_at
`;

const unavailable = (operation: string) => (cause: unknown) =>
  PersistenceUnavailable.new({ operation }, cause);

const encodedTimestamp = (value: typeof Timestamp.Type) =>
  Schema.encodeSync(Timestamp)(value);

const credentialReference = (id: string | null) =>
  id === null
    ? Effect.succeed(undefined)
    : Schema.decodeUnknownEffect(EnvironmentVariableId)(id).pipe(
        Effect.map(integrationCredentialReferenceFor),
      );

const decodeConnections = (input: unknown) =>
  Schema.decodeUnknownEffect(Schema.Array(ConnectionRow))(input).pipe(
    Effect.flatMap((rows) =>
      Effect.all(
        rows.map((row) =>
          Effect.gen(function* () {
            const accessTokenReference = yield* credentialReference(
              row.access_token_reference_id,
            );
            const refreshTokenReference = yield* credentialReference(
              row.refresh_token_reference_id,
            );
            return yield* Schema.decodeUnknownEffect(IntegrationConnection)({
              id: row.id,
              owner: { scope: row.owner_scope, id: row.owner_id },
              provider: row.provider,
              status: row.status,
              health: row.health,
              providerAccountId: row.provider_account_id,
              providerAccountLogin: row.provider_account_login,
              grantedScopes: JSON.parse(row.granted_scopes),
              ...(accessTokenReference === undefined
                ? {}
                : { accessTokenReference }),
              ...(refreshTokenReference === undefined
                ? {}
                : { refreshTokenReference }),
              ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
              ...(row.refresh_expires_at === null
                ? {}
                : { refreshExpiresAt: row.refresh_expires_at }),
              ...(row.last_health_check_at === null
                ? {}
                : { lastHealthCheckAt: row.last_health_check_at }),
              ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
              revocationStatus: row.revocation_status,
              createdAt: row.created_at,
              updatedAt: row.updated_at,
            });
          }),
        ),
      ),
    ),
  );

const decodeRepositories = (input: unknown) =>
  Schema.decodeUnknownEffect(Schema.Array(RepositoryRow))(input).pipe(
    Effect.flatMap((rows) =>
      Effect.all(
        rows.map((row) =>
          Schema.decodeUnknownEffect(IntegrationRepository)({
            connectionId: row.connection_id,
            providerRepositoryId: row.provider_repository_id,
            fullName: row.full_name,
            webUrl: row.web_url,
            cloneUrl: row.clone_url,
            visibility: row.visibility,
            selected: row.selected === 1,
            lastAuthorizedAt: row.last_authorized_at,
          }),
        ),
      ),
    ),
  );

const queryConnections = Effect.fn("IntegrationRepository.queryConnections")(
  function* (
    db: D1Database,
    owner: IntegrationOwner,
    suffix: string,
    values: ReadonlyArray<unknown>,
  ) {
    const result = yield* Effect.tryPromise({
      try: () =>
        db
          .prepare(
            `SELECT ${connectionColumns}
               FROM integration_connection
              WHERE owner_scope = ? AND owner_id = ? ${suffix}`,
          )
          .bind(owner.scope, owner.id, ...values)
          .all(),
      catch: unavailable("settings.integrations.listConnections"),
    });
    return yield* decodeConnections(result.results);
  },
);

export const IntegrationRepositoryD1 = (db: D1Database) =>
  Layer.succeed(
    IntegrationRepositoryStore,
    IntegrationRepositoryStore.of({
      listConnections: (owner) =>
        queryConnections(db, owner, "ORDER BY provider ASC", []),
      findConnection: Effect.fn("IntegrationRepository.findConnection")(
        function* (owner, id) {
          const rows = yield* queryConnections(db, owner, "AND id = ?", [id]);
          const connection = rows[0];
          if (connection === undefined)
            return yield* new IntegrationConnectionNotFound();
          return connection;
        },
      ),
      findConnectionByProvider: Effect.fn(
        "IntegrationRepository.findConnectionByProvider",
      )(function* (owner, provider) {
        const rows = yield* queryConnections(db, owner, "AND provider = ?", [
          provider,
        ]);
        return rows[0];
      }),
      saveConnection: Effect.fn("IntegrationRepository.saveConnection")(
        function* (connection, repositories, previousConnection) {
          const connectionWrite =
            previousConnection === undefined
              ? db
                  .prepare(
                    `INSERT INTO integration_connection (
                       id, owner_scope, owner_id, provider, status, health,
                       provider_account_id, provider_account_login, granted_scopes,
                       access_token_reference_id, refresh_token_reference_id,
                       expires_at, refresh_expires_at, last_health_check_at,
                       revoked_at, revocation_status, created_at, updated_at
                     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                  )
                  .bind(
                    connection.id,
                    connection.owner.scope,
                    connection.owner.id,
                    connection.provider,
                    connection.status,
                    connection.health,
                    connection.providerAccountId,
                    connection.providerAccountLogin,
                    JSON.stringify(connection.grantedScopes),
                    connection.accessTokenReference?.id ?? null,
                    connection.refreshTokenReference?.id ?? null,
                    connection.expiresAt === undefined
                      ? null
                      : encodedTimestamp(connection.expiresAt),
                    connection.refreshExpiresAt === undefined
                      ? null
                      : encodedTimestamp(connection.refreshExpiresAt),
                    connection.lastHealthCheckAt === undefined
                      ? null
                      : encodedTimestamp(connection.lastHealthCheckAt),
                    connection.revokedAt === undefined
                      ? null
                      : encodedTimestamp(connection.revokedAt),
                    connection.revocationStatus,
                    encodedTimestamp(connection.createdAt),
                    encodedTimestamp(connection.updatedAt),
                  )
              : db
                  .prepare(
                    `UPDATE integration_connection SET
                       status = ?, health = ?, provider_account_id = ?,
                       provider_account_login = ?, granted_scopes = ?,
                       access_token_reference_id = ?, refresh_token_reference_id = ?,
                       expires_at = ?, refresh_expires_at = ?,
                       last_health_check_at = ?, revoked_at = ?,
                       revocation_status = ?, updated_at = ?
                     WHERE id = ? AND owner_scope = ? AND owner_id = ?
                       AND updated_at = ? AND status = ?
                       AND access_token_reference_id IS ?
                       AND refresh_token_reference_id IS ?`,
                  )
                  .bind(
                    connection.status,
                    connection.health,
                    connection.providerAccountId,
                    connection.providerAccountLogin,
                    JSON.stringify(connection.grantedScopes),
                    connection.accessTokenReference?.id ?? null,
                    connection.refreshTokenReference?.id ?? null,
                    connection.expiresAt === undefined
                      ? null
                      : encodedTimestamp(connection.expiresAt),
                    connection.refreshExpiresAt === undefined
                      ? null
                      : encodedTimestamp(connection.refreshExpiresAt),
                    connection.lastHealthCheckAt === undefined
                      ? null
                      : encodedTimestamp(connection.lastHealthCheckAt),
                    connection.revokedAt === undefined
                      ? null
                      : encodedTimestamp(connection.revokedAt),
                    connection.revocationStatus,
                    encodedTimestamp(connection.updatedAt),
                    previousConnection.id,
                    previousConnection.owner.scope,
                    previousConnection.owner.id,
                    encodedTimestamp(previousConnection.updatedAt),
                    previousConnection.status,
                    previousConnection.accessTokenReference?.id ?? null,
                    previousConnection.refreshTokenReference?.id ?? null,
                  );
          const guardedByWrittenConnection =
            previousConnection === undefined
              ? ""
              : `AND EXISTS (
                   SELECT 1 FROM integration_connection
                    WHERE id = ? AND updated_at = ?
                      AND status = ? AND access_token_reference_id IS ?
                 )`;
          const guardValues =
            previousConnection === undefined
              ? []
              : [
                  connection.id,
                  encodedTimestamp(connection.updatedAt),
                  connection.status,
                  connection.accessTokenReference?.id ?? null,
                ];
          const replaceRepositories = [
            db
              .prepare(
                `DELETE FROM integration_repository
                  WHERE connection_id = ? ${guardedByWrittenConnection}`,
              )
              .bind(connection.id, ...guardValues),
            ...repositories.map((repository) =>
              db
                .prepare(
                  `INSERT INTO integration_repository (
                     connection_id, provider_repository_id, full_name, web_url,
                     clone_url, visibility, selected, last_authorized_at
                   ) SELECT ?, ?, ?, ?, ?, ?, ?, ?
                    WHERE 1 = 1 ${guardedByWrittenConnection}`,
                )
                .bind(
                  connection.id,
                  repository.providerRepositoryId,
                  repository.fullName,
                  repository.webUrl,
                  repository.cloneUrl,
                  repository.visibility,
                  repository.selected ? 1 : 0,
                  encodedTimestamp(repository.lastAuthorizedAt),
                  ...guardValues,
                ),
            ),
          ];
          const results = yield* Effect.tryPromise({
            try: () => db.batch([connectionWrite, ...replaceRepositories]),
            catch: unavailable("settings.integrations.saveConnection"),
          });
          return results[0]?.meta.changes === 1;
        },
      ),
      replaceConnection: Effect.fn("IntegrationRepository.replaceConnection")(
        function* (connection) {
          const result = yield* Effect.tryPromise({
            try: () =>
              db
                .prepare(
                  `UPDATE integration_connection SET
                     status = ?, health = ?, provider_account_id = ?,
                     provider_account_login = ?, granted_scopes = ?,
                     access_token_reference_id = ?, refresh_token_reference_id = ?,
                     expires_at = ?, refresh_expires_at = ?,
                     last_health_check_at = ?, revoked_at = ?,
                     revocation_status = ?, updated_at = ?
                   WHERE id = ? AND owner_scope = ? AND owner_id = ?`,
                )
                .bind(
                  connection.status,
                  connection.health,
                  connection.providerAccountId,
                  connection.providerAccountLogin,
                  JSON.stringify(connection.grantedScopes),
                  connection.accessTokenReference?.id ?? null,
                  connection.refreshTokenReference?.id ?? null,
                  connection.expiresAt === undefined
                    ? null
                    : encodedTimestamp(connection.expiresAt),
                  connection.refreshExpiresAt === undefined
                    ? null
                    : encodedTimestamp(connection.refreshExpiresAt),
                  connection.lastHealthCheckAt === undefined
                    ? null
                    : encodedTimestamp(connection.lastHealthCheckAt),
                  connection.revokedAt === undefined
                    ? null
                    : encodedTimestamp(connection.revokedAt),
                  connection.revocationStatus,
                  encodedTimestamp(connection.updatedAt),
                  connection.id,
                  connection.owner.scope,
                  connection.owner.id,
                )
                .run(),
            catch: unavailable("settings.integrations.replaceConnection"),
          });
          if (result.meta.changes !== 1)
            return yield* new IntegrationConnectionNotFound();
        },
      ),
      listRepositories: Effect.fn("IntegrationRepository.listRepositories")(
        function* (connectionId) {
          const result = yield* Effect.tryPromise({
            try: () =>
              db
                .prepare(
                  `SELECT connection_id, provider_repository_id, full_name,
                          web_url, clone_url, visibility, selected,
                          last_authorized_at
                     FROM integration_repository
                    WHERE connection_id = ?
                    ORDER BY full_name ASC`,
                )
                .bind(connectionId)
                .all(),
            catch: unavailable("settings.integrations.listRepositories"),
          });
          return yield* decodeRepositories(result.results);
        },
      ),
      replaceRepositories: Effect.fn(
        "IntegrationRepository.replaceRepositories",
      )(function* (connectionId, repositories) {
        const statements = [
          db
            .prepare(
              "DELETE FROM integration_repository WHERE connection_id = ?",
            )
            .bind(connectionId),
          ...repositories.map((repository) =>
            db
              .prepare(
                `INSERT INTO integration_repository (
                   connection_id, provider_repository_id, full_name, web_url,
                   clone_url, visibility, selected, last_authorized_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .bind(
                connectionId,
                repository.providerRepositoryId,
                repository.fullName,
                repository.webUrl,
                repository.cloneUrl,
                repository.visibility,
                repository.selected ? 1 : 0,
                encodedTimestamp(repository.lastAuthorizedAt),
              ),
          ),
        ];
        yield* Effect.tryPromise({
          try: () => db.batch(statements),
          catch: unavailable("settings.integrations.replaceRepositories"),
        });
      }),
      selectRepositories: Effect.fn("IntegrationRepository.selectRepositories")(
        function* (connectionId, ids) {
          const statements = [
            db
              .prepare(
                "UPDATE integration_repository SET selected = 0 WHERE connection_id = ?",
              )
              .bind(connectionId),
            ...ids.map((id) =>
              db
                .prepare(
                  `UPDATE integration_repository SET selected = 1
                    WHERE connection_id = ? AND provider_repository_id = ?`,
                )
                .bind(connectionId, id),
            ),
          ];
          yield* Effect.tryPromise({
            try: () => db.batch(statements),
            catch: unavailable("settings.integrations.selectRepositories"),
          });
        },
      ),
      disconnectImpact: Effect.fn("IntegrationRepository.disconnectImpact")(
        function* (connectionId) {
          const result = yield* Effect.tryPromise({
            try: () =>
              db
                .prepare(
                  `SELECT resource_kind, count(*) AS count
                     FROM integration_resource_binding
                    WHERE connection_id = ?
                    GROUP BY resource_kind`,
                )
                .bind(connectionId)
                .all<{ resource_kind: string; count: number }>(),
            catch: unavailable("settings.integrations.disconnectImpact"),
          });
          const count = (kind: string) =>
            result.results.find((row) => row.resource_kind === kind)?.count ??
            0;
          return {
            projects: count("project"),
            jobs: count("job"),
            previews: count("preview"),
          };
        },
      ),
      insertOAuthTransaction: Effect.fn(
        "IntegrationRepository.insertOAuthTransaction",
      )(function* (transaction) {
        yield* Effect.tryPromise({
          try: () =>
            db
              .prepare(
                `INSERT INTO integration_oauth_transaction (
                   id, state_hash, user_id, browser_session_id, provider,
                   verifier_reference_id, callback_url, expires_at, created_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .bind(
                transaction.id,
                transaction.stateHash,
                transaction.userId,
                transaction.browserSessionId,
                transaction.provider,
                transaction.verifierReference.id,
                transaction.callbackUrl,
                transaction.expiresAt,
                transaction.createdAt,
              )
              .run(),
          catch: unavailable("settings.integrations.insertOAuthTransaction"),
        });
      }),
      consumeOAuthTransaction: Effect.fn(
        "IntegrationRepository.consumeOAuthTransaction",
      )(function* (stateHash, userId, browserSessionId, now) {
        const consumed = yield* Effect.tryPromise({
          try: () =>
            db
              .prepare(
                `UPDATE integration_oauth_transaction SET consumed_at = ?
                  WHERE state_hash = ? AND user_id = ? AND browser_session_id = ?
                    AND consumed_at IS NULL AND expires_at > ?`,
              )
              .bind(now, stateHash, userId, browserSessionId, now)
              .run(),
          catch: unavailable("settings.integrations.consumeOAuthTransaction"),
        });
        if (consumed.meta.changes !== 1)
          return yield* new IntegrationOAuthStateInvalid();
        const result = yield* Effect.tryPromise({
          try: () =>
            db
              .prepare(
                `SELECT id, state_hash, user_id, browser_session_id, provider,
                        verifier_reference_id, callback_url, expires_at, created_at
                   FROM integration_oauth_transaction
                  WHERE state_hash = ?`,
              )
              .bind(stateHash)
              .all(),
          catch: unavailable("settings.integrations.readOAuthTransaction"),
        });
        const rows = yield* Schema.decodeUnknownEffect(Schema.Array(OAuthRow))(
          result.results,
        );
        const row = rows[0];
        if (row === undefined) return yield* new IntegrationOAuthStateInvalid();
        const verifierId = yield* Schema.decodeUnknownEffect(
          EnvironmentVariableId,
        )(row.verifier_reference_id);
        return {
          id: row.id,
          stateHash: row.state_hash,
          userId: row.user_id,
          browserSessionId: row.browser_session_id,
          provider: row.provider,
          verifierReference: integrationCredentialReferenceFor(verifierId),
          callbackUrl: row.callback_url,
          expiresAt: row.expires_at,
          createdAt: row.created_at,
        } as StoredIntegrationOAuthTransaction;
      }),
      removeOAuthTransaction: Effect.fn(
        "IntegrationRepository.removeOAuthTransaction",
      )(function* (id) {
        yield* Effect.tryPromise({
          try: () =>
            db
              .prepare("DELETE FROM integration_oauth_transaction WHERE id = ?")
              .bind(id)
              .run(),
          catch: unavailable("settings.integrations.removeOAuthTransaction"),
        });
      }),
      workspaceCoverage: Effect.fn("IntegrationRepository.workspaceCoverage")(
        function* (workspaceId) {
          const result = yield* Effect.tryPromise({
            try: () =>
              db
                .prepare(
                  `WITH providers(provider) AS (
                     VALUES ('github'), ('gitlab'), ('forgejo')
                   )
                   SELECT providers.provider,
                          count(DISTINCT connection.owner_id) AS connected_members,
                          (SELECT count(*) FROM member WHERE organizationId = ?) AS total_members
                     FROM providers
                     LEFT JOIN member ON member.organizationId = ?
                     LEFT JOIN integration_connection AS connection
                            ON connection.owner_scope = 'personal'
                           AND connection.owner_id = member.userId
                           AND connection.provider = providers.provider
                           AND connection.status = 'connected'
                    GROUP BY providers.provider
                    ORDER BY providers.provider`,
                )
                .bind(workspaceId, workspaceId)
                .all<{
                  provider: GitIntegrationProvider;
                  connected_members: number;
                  total_members: number;
                }>(),
            catch: unavailable("settings.integrations.workspaceCoverage"),
          });
          return result.results.map((row) => ({
            provider: row.provider,
            connectedMembers: row.connected_members,
            totalMembers: row.total_members,
          }));
        },
      ),
    }),
  );
