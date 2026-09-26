import {
  EnvironmentVariableEnvelope,
  ModelConnectionTarget,
  ModelCredentialId,
  PersistenceUnavailable,
  type StoredModelConnection,
  Timestamp,
} from "@dx/domain";
import { Context, Effect, Layer, Schema } from "effect";
import { settingsPersistenceLogger } from "../../logging.js";
import {
  insertConnectionStatements,
  replaceConnectionStatements,
} from "./repository-d1.js";

export const ModelCredentialName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
).pipe(Schema.brand("@dx/ModelCredentialName"));

export type ModelCredentialName = typeof ModelCredentialName.Type;

export const StoredModelCredential = Schema.Struct({
  id: ModelCredentialId,
  target: ModelConnectionTarget,
  name: ModelCredentialName,
  envelope: EnvironmentVariableEnvelope,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

export type StoredModelCredential = typeof StoredModelCredential.Type;

export class ModelCredentialNotFound extends Schema.TaggedError<ModelCredentialNotFound>()(
  "ModelCredentialNotFound",
  {},
) {}

export interface ModelCredentialRepositoryShape {
  readonly insertConnection: (
    connection: StoredModelConnection,
    credential: StoredModelCredential,
  ) => Effect.Effect<void, PersistenceUnavailable>;
  readonly find: (
    target: ModelConnectionTarget,
    id: ModelCredentialId,
  ) => Effect.Effect<
    StoredModelCredential,
    PersistenceUnavailable | Schema.SchemaError | ModelCredentialNotFound
  >;
  readonly remove: (
    target: ModelConnectionTarget,
    id: ModelCredentialId,
  ) => Effect.Effect<void, PersistenceUnavailable | ModelCredentialNotFound>;
  readonly rotateConnection: (
    connection: StoredModelConnection,
    previousId: ModelCredentialId | undefined,
    credential: StoredModelCredential,
  ) => Effect.Effect<void, PersistenceUnavailable>;
}

/**
 * Backend-only model credential store. Credentials are created inline with
 * their owning model connection, stay inside the credential coordinator, and
 * are never exposed to workspace environment injection or the env-var UI.
 */
export class ModelCredentialRepository extends Context.Service<
  ModelCredentialRepository,
  ModelCredentialRepositoryShape
>()("@dx/core/settings/model-routing/ModelCredentialRepository") {}

const ModelCredentialRow = Schema.Struct({
  id: Schema.String,
  scope: Schema.String,
  target_id: Schema.String,
  name: Schema.String,
  envelope_version: Schema.Number,
  key_version: Schema.Number,
  value_nonce: Schema.String,
  ciphertext: Schema.String,
  wrapped_key_nonce: Schema.String,
  wrapped_key: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.String,
});

const columns = `
  id, scope, target_id, name,
  envelope_version, key_version, value_nonce, ciphertext,
  wrapped_key_nonce, wrapped_key, created_at, updated_at
`;

const decodeRows = (input: unknown) =>
  Schema.decodeUnknownEffect(Schema.Array(ModelCredentialRow))(input).pipe(
    Effect.flatMap((rows) =>
      Effect.all(
        rows.map((row) =>
          Schema.decodeUnknownEffect(StoredModelCredential)({
            id: row.id,
            target: { scope: row.scope, id: row.target_id },
            name: row.name,
            envelope: {
              version: row.envelope_version,
              keyVersion: row.key_version,
              valueNonce: row.value_nonce,
              ciphertext: row.ciphertext,
              wrappedKeyNonce: row.wrapped_key_nonce,
              wrappedKey: row.wrapped_key,
            },
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          }),
        ),
      ),
    ),
  );

const encodedTimestamp = (value: typeof Timestamp.Type) =>
  Schema.encodeSync(Timestamp)(value);

const insertCredentialStatement = (
  db: D1Database,
  credential: StoredModelCredential,
) =>
  db
    .prepare(
      `INSERT INTO model_credential (
         id, scope, target_id, name,
         envelope_version, key_version, value_nonce, ciphertext,
         wrapped_key_nonce, wrapped_key, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      credential.id,
      credential.target.scope,
      credential.target.id,
      credential.name,
      credential.envelope.version,
      credential.envelope.keyVersion,
      credential.envelope.valueNonce,
      credential.envelope.ciphertext,
      credential.envelope.wrappedKeyNonce,
      credential.envelope.wrappedKey,
      encodedTimestamp(credential.createdAt),
      encodedTimestamp(credential.updatedAt),
    );

export const ModelCredentialRepositoryD1 = (db: D1Database) =>
  Layer.effect(
    ModelCredentialRepository,
    Effect.gen(function* () {
      const unavailable = (operation: string) => (cause: unknown) =>
        PersistenceUnavailable.new({ operation }, cause);

      const find = Effect.fn("ModelCredentialRepository.find")(function* (
        target: ModelConnectionTarget,
        id: ModelCredentialId,
      ) {
        const result = yield* Effect.tryPromise({
          try: () =>
            db
              .prepare(
                `SELECT ${columns}
                   FROM model_credential
                   WHERE scope = ? AND target_id = ? AND id = ?`,
              )
              .bind(target.scope, target.id, id)
              .all(),
          catch: unavailable("settings.modelCredentials.find"),
        });
        const rows = yield* decodeRows(result.results);
        const credential = rows[0];
        if (credential === undefined)
          return yield* new ModelCredentialNotFound();
        return credential;
      });

      return ModelCredentialRepository.of({
        insertConnection: Effect.fn(
          "ModelCredentialRepository.insertConnection",
        )(function* (connection, credential) {
          const results = yield* Effect.tryPromise({
            try: () =>
              db.batch([
                insertCredentialStatement(db, credential),
                ...insertConnectionStatements(db, connection),
                db
                  .prepare(
                    `DELETE FROM model_credential
                     WHERE id = ?
                       AND NOT EXISTS (
                         SELECT 1 FROM model_connection
                         WHERE model_credential_id = ?
                       )`,
                  )
                  .bind(credential.id, credential.id),
              ]),
            catch: unavailable("settings.modelCredentials.insertConnection"),
          });
          if ((results[1]?.meta.changes ?? 0) !== 1)
            return yield* unavailable("settings.modelRouting.connectionLimit")(
              new Error("Model connection scope limit reached."),
            );
          settingsPersistenceLogger.info(
            "Model credential persistence succeeded.",
            {
              event: "model_credential_persistence_created",
              modelCredentialId: credential.id,
              scope: credential.target.scope,
            },
          );
        }),
        find,
        rotateConnection: Effect.fn(
          "ModelCredentialRepository.rotateConnection",
        )(function* (connection, previousId, credential) {
          const insert = insertCredentialStatement(db, credential);
          const replacements = replaceConnectionStatements(
            db,
            connection,
            previousId ?? null,
          );
          const retirePrevious = db
            .prepare(
              `DELETE FROM model_credential WHERE scope = ? AND target_id = ? AND id = ?
                 AND EXISTS (
                   SELECT 1 FROM model_connection
                   WHERE scope = ? AND target_id = ? AND id = ? AND model_credential_id = ?
                 )`,
            )
            .bind(
              connection.target.scope,
              connection.target.id,
              previousId ?? "",
              connection.target.scope,
              connection.target.id,
              connection.id,
              credential.id,
            );
          const removeUnclaimed = db
            .prepare(
              `DELETE FROM model_credential WHERE scope = ? AND target_id = ? AND id = ?
                 AND NOT EXISTS (
                   SELECT 1 FROM model_connection
                   WHERE scope = ? AND target_id = ? AND id = ? AND model_credential_id = ?
                 )`,
            )
            .bind(
              connection.target.scope,
              connection.target.id,
              credential.id,
              connection.target.scope,
              connection.target.id,
              connection.id,
              credential.id,
            );
          const results = yield* Effect.tryPromise({
            try: () =>
              db.batch([
                insert,
                ...replacements,
                retirePrevious,
                removeUnclaimed,
              ]),
            catch: unavailable("settings.modelCredentials.rotateConnection"),
          });
          if ((results[1]?.meta.changes ?? 0) !== 1) {
            return yield* unavailable(
              "settings.modelCredentials.rotateConnection",
            )(new Error("Connection changed while rotating its credential."));
          }
        }),
        remove: Effect.fn("ModelCredentialRepository.remove")(
          function* (target, id) {
            const result = yield* Effect.tryPromise({
              try: () =>
                db
                  .prepare(
                    "DELETE FROM model_credential WHERE scope = ? AND target_id = ? AND id = ?",
                  )
                  .bind(target.scope, target.id, id)
                  .run(),
              catch: unavailable("settings.modelCredentials.remove"),
            });
            if (result.meta.changes !== 1)
              return yield* new ModelCredentialNotFound();
            settingsPersistenceLogger.info(
              "Model credential persistence succeeded.",
              {
                event: "model_credential_persistence_deleted",
                modelCredentialId: id,
                scope: target.scope,
              },
            );
          },
        ),
      });
    }),
  );
