import {
  MAX_MODEL_CONNECTIONS_PER_SCOPE,
  type ModelConnectionId,
  ModelConnectionNotFound,
  type ModelConnectionTarget,
  type ModelCredentialId,
  ModelRoutingRepository,
  PersistenceUnavailable,
  StoredModelConnection,
  Timestamp,
} from "@dx/domain";
import { Effect, Layer, Schema } from "effect";
import { settingsPersistenceLogger } from "../../logging.js";

const ConnectionRow = Schema.Struct({
  id: Schema.String,
  scope: Schema.String,
  target_id: Schema.String,
  name: Schema.String,
  kind: Schema.String,
  provider_id: Schema.String,
  base_url: Schema.NullOr(Schema.String),
  format: Schema.NullOr(Schema.String),
  fields: Schema.String,
  enabled: Schema.Number,
  priority: Schema.Number,
  health_state: Schema.String,
  health_code: Schema.String,
  health_checked_at: Schema.NullOr(Schema.String),
  model_credential_id: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  updated_at: Schema.String,
});

const ConnectionModelRow = Schema.Struct({
  connection_id: Schema.String,
  canonical: Schema.String,
  upstream: Schema.NullOr(Schema.String),
  position: Schema.Number,
});

const ConnectionHeaderRow = Schema.Struct({
  connection_id: Schema.String,
  name: Schema.String,
  value: Schema.String,
  position: Schema.Number,
});

type ConnectionRow = typeof ConnectionRow.Type;
type ConnectionModelRow = typeof ConnectionModelRow.Type;
type ConnectionHeaderRow = typeof ConnectionHeaderRow.Type;

const decodeJson = (value: string, operation: string) =>
  Effect.try({
    try: () => JSON.parse(value) as unknown,
    catch: (cause) => PersistenceUnavailable.new({ operation }, cause),
  });

const decodeConnection = (
  row: ConnectionRow,
  models: ReadonlyArray<ConnectionModelRow>,
  headers: ReadonlyArray<ConnectionHeaderRow>,
) =>
  Effect.gen(function* () {
    const fields = yield* decodeJson(
      row.fields,
      "settings.modelRouting.decodeConnectionFields",
    );
    return yield* Schema.decodeUnknownEffect(StoredModelConnection)({
      id: row.id,
      target: { scope: row.scope, id: row.target_id },
      name: row.name,
      kind: row.kind,
      providerId: row.provider_id,
      ...(row.base_url === null ? {} : { baseUrl: row.base_url }),
      ...(row.format === null ? {} : { format: row.format }),
      fields,
      headers: headers.map(({ name, value }) => ({ name, value })),
      models: models.map(({ canonical, upstream }) => ({
        canonical,
        ...(upstream === null ? {} : { upstream }),
      })),
      enabled: row.enabled === 1,
      priority: row.priority,
      health: {
        state: row.health_state,
        code: row.health_code,
        ...(row.health_checked_at === null
          ? {}
          : { checkedAt: row.health_checked_at }),
      },
      ...(row.model_credential_id === null
        ? {}
        : { credentialId: row.model_credential_id }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  });

const encodedTimestamp = (value: typeof Timestamp.Type) =>
  Schema.encodeSync(Timestamp)(value);

const connectionColumns = `
  id, scope, target_id, name, kind, provider_id, base_url, format, fields,
  enabled, priority, health_state, health_code, health_checked_at,
  model_credential_id, created_at, updated_at
`;

export const insertConnectionStatements = (
  db: D1Database,
  connection: StoredModelConnection,
) => [
  db
    .prepare(
      `INSERT INTO model_connection (${connectionColumns})
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE (SELECT COUNT(*) FROM model_connection WHERE scope = ? AND target_id = ?) < ?`,
    )
    .bind(
      connection.id,
      connection.target.scope,
      connection.target.id,
      connection.name,
      connection.kind,
      connection.providerId,
      connection.baseUrl ?? null,
      connection.format ?? null,
      JSON.stringify(connection.fields),
      connection.enabled ? 1 : 0,
      connection.priority,
      connection.health.state,
      connection.health.code,
      connection.health.checkedAt === undefined
        ? null
        : encodedTimestamp(connection.health.checkedAt),
      connection.credentialId ?? null,
      encodedTimestamp(connection.createdAt),
      encodedTimestamp(connection.updatedAt),
      connection.target.scope,
      connection.target.id,
      MAX_MODEL_CONNECTIONS_PER_SCOPE,
    ),
  ...connection.models.map((model, position) =>
    db
      .prepare(
        `INSERT INTO model_connection_model (connection_id, canonical, upstream, position)
         SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM model_connection WHERE id = ?)`,
      )
      .bind(
        connection.id,
        model.canonical,
        model.upstream ?? null,
        position,
        connection.id,
      ),
  ),
  ...connection.headers.map((header, position) =>
    db
      .prepare(
        `INSERT INTO model_connection_header (connection_id, name, value, position)
         SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM model_connection WHERE id = ?)`,
      )
      .bind(connection.id, header.name, header.value, position, connection.id),
  ),
];

export const replaceConnectionStatements = (
  db: D1Database,
  connection: StoredModelConnection,
  expectedCredentialId?: ModelCredentialId | null,
) => {
  const guarded = expectedCredentialId !== undefined;
  const credentialPredicate =
    expectedCredentialId === null
      ? "model_credential_id IS NULL"
      : "model_credential_id = ?";
  const ownerExists = `EXISTS (
    SELECT 1 FROM model_connection
    WHERE scope = ? AND target_id = ? AND id = ? AND model_credential_id = ?
  )`;
  const ownerBindings = [
    connection.target.scope,
    connection.target.id,
    connection.id,
    connection.credentialId,
  ];
  const updateBindings = [
    connection.name,
    connection.kind,
    connection.providerId,
    connection.baseUrl ?? null,
    connection.format ?? null,
    JSON.stringify(connection.fields),
    connection.enabled ? 1 : 0,
    connection.priority,
    connection.health.state,
    connection.health.code,
    connection.health.checkedAt === undefined
      ? null
      : encodedTimestamp(connection.health.checkedAt),
    connection.credentialId ?? null,
    encodedTimestamp(connection.updatedAt),
    connection.target.scope,
    connection.target.id,
    connection.id,
    ...(guarded && expectedCredentialId !== null ? [expectedCredentialId] : []),
  ];
  return [
    db
      .prepare(
        `UPDATE model_connection
         SET name = ?, kind = ?, provider_id = ?, base_url = ?,
             format = ?, fields = ?, enabled = ?, priority = ?,
             health_state = ?, health_code = ?, health_checked_at = ?,
             model_credential_id = ?, updated_at = ?
         WHERE scope = ? AND target_id = ? AND id = ?
         ${guarded ? `AND ${credentialPredicate}` : ""}`,
      )
      .bind(...updateBindings),
    db
      .prepare(
        `DELETE FROM model_connection_model WHERE connection_id = ?
         ${guarded ? `AND ${ownerExists}` : ""}`,
      )
      .bind(connection.id, ...(guarded ? ownerBindings : [])),
    db
      .prepare(
        `DELETE FROM model_connection_header WHERE connection_id = ?
         ${guarded ? `AND ${ownerExists}` : ""}`,
      )
      .bind(connection.id, ...(guarded ? ownerBindings : [])),
    ...connection.models.map((model, position) =>
      db
        .prepare(
          guarded
            ? `INSERT INTO model_connection_model (connection_id, canonical, upstream, position)
               SELECT ?, ?, ?, ? WHERE ${ownerExists}`
            : `INSERT INTO model_connection_model (connection_id, canonical, upstream, position)
               VALUES (?, ?, ?, ?)`,
        )
        .bind(
          connection.id,
          model.canonical,
          model.upstream ?? null,
          position,
          ...(guarded ? ownerBindings : []),
        ),
    ),
    ...connection.headers.map((header, position) =>
      db
        .prepare(
          guarded
            ? `INSERT INTO model_connection_header (connection_id, name, value, position)
               SELECT ?, ?, ?, ? WHERE ${ownerExists}`
            : `INSERT INTO model_connection_header (connection_id, name, value, position)
               VALUES (?, ?, ?, ?)`,
        )
        .bind(
          connection.id,
          header.name,
          header.value,
          position,
          ...(guarded ? ownerBindings : []),
        ),
    ),
  ];
};

export const ModelRoutingRepositoryD1 = (db: D1Database) =>
  Layer.effect(
    ModelRoutingRepository,
    Effect.gen(function* () {
      const unavailable = (operation: string) => (cause: unknown) =>
        PersistenceUnavailable.new({ operation }, cause);

      const listConnections = Effect.fn(
        "ModelRoutingRepository.listConnections",
      )(function* (target: ModelConnectionTarget) {
        const result = yield* Effect.tryPromise({
          try: () =>
            db
              .prepare(
                `SELECT ${connectionColumns}
                 FROM model_connection
                 WHERE scope = ? AND target_id = ?
                 ORDER BY priority ASC, created_at ASC, id`,
              )
              .bind(target.scope, target.id)
              .all(),
          catch: unavailable("settings.modelRouting.listConnections"),
        });
        const rows = yield* Schema.decodeUnknownEffect(
          Schema.Array(ConnectionRow),
        )(result.results);
        if (rows.length === 0) return [];
        const placeholders = rows.map(() => "?").join(", ");
        const [models, headers] = yield* Effect.all([
          Effect.tryPromise({
            try: () =>
              db
                .prepare(
                  `SELECT connection_id, canonical, upstream, position
                   FROM model_connection_model
                   WHERE connection_id IN (${placeholders})
                   ORDER BY position ASC, canonical`,
                )
                .bind(...rows.map(({ id }) => id))
                .all(),
            catch: unavailable("settings.modelRouting.listConnectionModels"),
          }),
          Effect.tryPromise({
            try: () =>
              db
                .prepare(
                  `SELECT connection_id, name, value, position
                   FROM model_connection_header
                   WHERE connection_id IN (${placeholders})
                   ORDER BY position ASC, name`,
                )
                .bind(...rows.map(({ id }) => id))
                .all(),
            catch: unavailable("settings.modelRouting.listConnectionHeaders"),
          }),
        ]);
        const modelRows = yield* Schema.decodeUnknownEffect(
          Schema.Array(ConnectionModelRow),
        )(models.results);
        const headerRows = yield* Schema.decodeUnknownEffect(
          Schema.Array(ConnectionHeaderRow),
        )(headers.results);
        return yield* Effect.all(
          rows.map((row) =>
            decodeConnection(
              row,
              modelRows.filter(({ connection_id }) => connection_id === row.id),
              headerRows.filter(
                ({ connection_id }) => connection_id === row.id,
              ),
            ),
          ),
        );
      });

      const findConnection = Effect.fn("ModelRoutingRepository.findConnection")(
        function* (target: ModelConnectionTarget, id: ModelConnectionId) {
          const values = yield* listConnections(target);
          const found = values.find((connection) => connection.id === id);
          return found === undefined
            ? yield* new ModelConnectionNotFound()
            : found;
        },
      );

      return ModelRoutingRepository.of({
        listConnections,
        findConnection,
        insertConnection: Effect.fn("ModelRoutingRepository.insertConnection")(
          function* (connection) {
            const result = yield* Effect.tryPromise({
              try: () => db.batch(insertConnectionStatements(db, connection)),
              catch: unavailable("settings.modelRouting.insertConnection"),
            });
            if ((result[0]?.meta.changes ?? 0) !== 1)
              return yield* unavailable(
                "settings.modelRouting.connectionLimit",
              )(new Error("Model connection scope limit reached."));
            settingsPersistenceLogger.info(
              "Model connection persistence succeeded.",
              {
                event: "model_connection_persistence_created",
                connectionId: connection.id,
                scope: connection.target.scope,
              },
            );
          },
        ),
        replaceConnection: Effect.fn(
          "ModelRoutingRepository.replaceConnection",
        )(function* (connection) {
          const statements = replaceConnectionStatements(db, connection);
          const result = yield* Effect.tryPromise({
            try: () => db.batch(statements),
            catch: unavailable("settings.modelRouting.replaceConnection"),
          });
          if ((result[0]?.meta.changes ?? 0) !== 1)
            return yield* new ModelConnectionNotFound();
        }),
        reorderConnections: Effect.fn(
          "ModelRoutingRepository.reorderConnections",
        )(function* (target, orderedIds) {
          const existing = yield* Effect.tryPromise({
            try: () =>
              db
                .prepare(
                  `SELECT id FROM model_connection
                   WHERE scope = ? AND target_id = ?`,
                )
                .bind(target.scope, target.id)
                .all<{ id: string }>(),
            catch: unavailable("settings.modelRouting.reorderConnections"),
          });
          const existingIds = new Set(existing.results.map(({ id }) => id));
          const ordered = new Set(orderedIds);
          if (
            ordered.size !== orderedIds.length ||
            existingIds.size !== ordered.size ||
            !orderedIds.every((id) => existingIds.has(id))
          ) {
            return yield* unavailable(
              "settings.modelRouting.reorderConnections",
            )(
              new Error(
                "Connection reorder must list every existing connection exactly once.",
              ),
            );
          }
          yield* Effect.tryPromise({
            try: () =>
              db.batch(
                orderedIds.map((id, index) =>
                  db
                    .prepare(
                      `UPDATE model_connection SET priority = ?
                       WHERE scope = ? AND target_id = ? AND id = ?`,
                    )
                    .bind(index, target.scope, target.id, id),
                ),
              ),
            catch: unavailable("settings.modelRouting.reorderConnections"),
          });
        }),
        removeConnection: Effect.fn("ModelRoutingRepository.removeConnection")(
          function* (target, id) {
            yield* findConnection(target, id);
            const results = yield* Effect.tryPromise({
              try: () =>
                db.batch([
                  db
                    .prepare(
                      "DELETE FROM model_connection_model WHERE connection_id = ?",
                    )
                    .bind(id),
                  db
                    .prepare(
                      `DELETE FROM model_credential
                       WHERE scope = ? AND target_id = ? AND id = (
                         SELECT model_credential_id FROM model_connection
                         WHERE scope = ? AND target_id = ? AND id = ?
                       )`,
                    )
                    .bind(target.scope, target.id, target.scope, target.id, id),
                  db
                    .prepare(
                      "DELETE FROM model_connection_header WHERE connection_id = ?",
                    )
                    .bind(id),
                  db
                    .prepare(
                      "DELETE FROM model_connection WHERE scope = ? AND target_id = ? AND id = ?",
                    )
                    .bind(target.scope, target.id, id),
                ]),
              catch: unavailable("settings.modelRouting.removeConnection"),
            });
            if ((results.at(-1)?.meta.changes ?? 0) !== 1)
              return yield* new ModelConnectionNotFound();
            settingsPersistenceLogger.info(
              "Model connection persistence succeeded.",
              {
                event: "model_connection_persistence_deleted",
                connectionId: id,
                scope: target.scope,
              },
            );
          },
        ),
      });
    }),
  );
