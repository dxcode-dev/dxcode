import {
  PersonalVerificationKey,
  PersistenceUnavailable,
  SigningKeyConflict,
  SigningKeyNotFound,
  SigningKeyRepository,
  StoredPersonalSigningKey,
  Timestamp,
  type SigningKeyId,
  type UserId,
  type VerificationKeyId,
} from "@dx/domain";
import { Effect, Layer, Result, Schema } from "effect";
import { settingsPersistenceLogger } from "../../logging.js";

const ManagedKeyRow = Schema.Struct({
  id: Schema.String,
  user_id: Schema.String,
  backend: Schema.String,
  public_key: Schema.String,
  fingerprint: Schema.String,
  envelope_version: Schema.Number,
  key_version: Schema.Number,
  value_nonce: Schema.String,
  ciphertext: Schema.String,
  wrapped_key_nonce: Schema.String,
  wrapped_key: Schema.String,
  created_at: Schema.String,
  rotated_at: Schema.String,
});

const VerificationKeyRow = Schema.Struct({
  id: Schema.String,
  user_id: Schema.String,
  name: Schema.String,
  public_key: Schema.String,
  fingerprint: Schema.String,
  created_at: Schema.String,
});

const decodeManaged = (row: typeof ManagedKeyRow.Type) =>
  Schema.decodeUnknownEffect(StoredPersonalSigningKey)({
    id: row.id,
    userId: row.user_id,
    backend: row.backend,
    publicKey: row.public_key,
    fingerprint: row.fingerprint,
    privateKeyReference: {
      version: 1,
      kind: "signing-private-key",
      id: row.id,
    },
    privateKeyEnvelope: {
      version: row.envelope_version,
      keyVersion: row.key_version,
      valueNonce: row.value_nonce,
      ciphertext: row.ciphertext,
      wrappedKeyNonce: row.wrapped_key_nonce,
      wrappedKey: row.wrapped_key,
    },
    createdAt: row.created_at,
    rotatedAt: row.rotated_at,
  });

const decodeVerification = (row: typeof VerificationKeyRow.Type) =>
  Schema.decodeUnknownEffect(PersonalVerificationKey)({
    id: row.id,
    userId: row.user_id,
    name: row.name,
    publicKey: row.public_key,
    fingerprint: row.fingerprint,
    createdAt: row.created_at,
  });

const encodedTimestamp = (value: typeof Timestamp.Type) =>
  Schema.encodeSync(Timestamp)(value);

export const SigningKeyRepositoryD1 = (db: D1Database) =>
  Layer.effect(
    SigningKeyRepository,
    Effect.gen(function* () {
      const unavailable = (operation: string) => (cause: unknown) =>
        PersistenceUnavailable.new({ operation }, cause);

      const findActiveManaged = Effect.fn(
        "SigningKeyRepository.findActiveManaged",
      )(function* (userId: UserId) {
        const result = yield* Effect.tryPromise({
          try: () =>
            db
              .prepare(
                `SELECT id, user_id, backend, public_key, fingerprint,
                   envelope_version, key_version, value_nonce, ciphertext,
                   wrapped_key_nonce, wrapped_key, created_at, rotated_at
                 FROM personal_signing_key
                 WHERE user_id = ? AND status = 'active'
                 LIMIT 1`,
              )
              .bind(userId)
              .all(),
          catch: unavailable("settings.signingKeys.findActiveManaged"),
        });
        const rows = yield* Schema.decodeUnknownEffect(
          Schema.Array(ManagedKeyRow),
        )(result.results);
        return rows[0] === undefined
          ? undefined
          : yield* decodeManaged(rows[0]);
      });

      const findVerificationInsertOutcome = Effect.fn(
        "SigningKeyRepository.findVerificationInsertOutcome",
      )(function* (key: PersonalVerificationKey) {
        const row = yield* Effect.tryPromise({
          try: () =>
            db
              .prepare(
                `SELECT id, user_id, name, algorithm, public_key, fingerprint,
                        status, created_at, revoked_at
                 FROM personal_verification_key
                 WHERE id = ? OR (user_id = ? AND fingerprint = ?)
                 LIMIT 1`,
              )
              .bind(key.id, key.userId, key.fingerprint)
              .first<{
                readonly id: string;
                readonly user_id: string;
                readonly name: string;
                readonly algorithm: string;
                readonly public_key: string;
                readonly fingerprint: string;
                readonly status: string;
                readonly created_at: string;
                readonly revoked_at: string | null;
              }>(),
          catch: unavailable(
            "settings.signingKeys.findVerificationInsertOutcome",
          ),
        });
        if (row === null) return "missing" as const;
        return row.id === key.id &&
          row.user_id === key.userId &&
          row.name === key.name &&
          row.algorithm === "ssh-ed25519" &&
          row.public_key === key.publicKey &&
          row.fingerprint === key.fingerprint &&
          row.status === "active" &&
          row.created_at === encodedTimestamp(key.createdAt) &&
          row.revoked_at === null
          ? ("committed" as const)
          : ("conflict" as const);
      });

      const insertManaged = Effect.fn("SigningKeyRepository.insertManaged")(
        function* (key: StoredPersonalSigningKey) {
          const result = yield* Effect.result(
            Effect.tryPromise({
              try: () =>
                db
                  .prepare(
                    `INSERT INTO personal_signing_key (
                       id, user_id, backend, status, public_key, fingerprint,
                       envelope_version, key_version, value_nonce, ciphertext,
                       wrapped_key_nonce, wrapped_key, created_at, rotated_at
                     ) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                  )
                  .bind(
                    key.id,
                    key.userId,
                    key.backend,
                    key.publicKey,
                    key.fingerprint,
                    key.privateKeyEnvelope.version,
                    key.privateKeyEnvelope.keyVersion,
                    key.privateKeyEnvelope.valueNonce,
                    key.privateKeyEnvelope.ciphertext,
                    key.privateKeyEnvelope.wrappedKeyNonce,
                    key.privateKeyEnvelope.wrappedKey,
                    encodedTimestamp(key.createdAt),
                    encodedTimestamp(key.rotatedAt),
                  )
                  .run(),
              catch: unavailable("settings.signingKeys.insertManaged"),
            }),
          );
          if (Result.isFailure(result)) {
            if ((yield* findActiveManaged(key.userId)) !== undefined) {
              return yield* new SigningKeyConflict();
            }
            return yield* result.failure;
          }
          settingsPersistenceLogger.info("Signing key persistence succeeded.", {
            event: "signing_key_persistence_created",
            signingKeyId: key.id,
          });
        },
      );

      const revokeStatement = (
        userId: UserId,
        id: SigningKeyId,
        revokedAt: typeof Timestamp.Type,
        replacementId: SigningKeyId | null,
      ) =>
        db
          .prepare(
            `UPDATE personal_signing_key
             SET status = 'revoked', envelope_version = NULL,
                 key_version = NULL, value_nonce = NULL, ciphertext = NULL,
                 wrapped_key_nonce = NULL, wrapped_key = NULL,
                 revoked_at = ?, replaced_by_id = ?
             WHERE user_id = ? AND id = ? AND status = 'active'`,
          )
          .bind(encodedTimestamp(revokedAt), replacementId, userId, id);

      return SigningKeyRepository.of({
        findActiveManaged,
        insertManaged,
        rotateManaged: Effect.fn("SigningKeyRepository.rotateManaged")(
          function* (userId, currentId, replacement, revokedAt) {
            const current = yield* findActiveManaged(userId);
            if (current?.id !== currentId)
              return yield* new SigningKeyNotFound();
            const insert = db
              .prepare(
                `INSERT INTO personal_signing_key (
                   id, user_id, backend, status, public_key, fingerprint,
                   envelope_version, key_version, value_nonce, ciphertext,
                   wrapped_key_nonce, wrapped_key, created_at, rotated_at
                 ) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .bind(
                replacement.id,
                replacement.userId,
                replacement.backend,
                replacement.publicKey,
                replacement.fingerprint,
                replacement.privateKeyEnvelope.version,
                replacement.privateKeyEnvelope.keyVersion,
                replacement.privateKeyEnvelope.valueNonce,
                replacement.privateKeyEnvelope.ciphertext,
                replacement.privateKeyEnvelope.wrappedKeyNonce,
                replacement.privateKeyEnvelope.wrappedKey,
                encodedTimestamp(replacement.createdAt),
                encodedTimestamp(replacement.rotatedAt),
              );
            const result = yield* Effect.tryPromise({
              try: () =>
                db.batch([
                  revokeStatement(userId, currentId, revokedAt, null),
                  insert,
                  db
                    .prepare(
                      `UPDATE personal_signing_key
                       SET replaced_by_id = ?
                       WHERE user_id = ? AND id = ? AND status = 'revoked'`,
                    )
                    .bind(replacement.id, userId, currentId),
                ]),
              catch: unavailable("settings.signingKeys.rotateManaged"),
            });
            if (
              result[0]?.meta.changes !== 1 ||
              result[1]?.success !== true ||
              result[2]?.meta.changes !== 1
            ) {
              return yield* new SigningKeyConflict();
            }
            settingsPersistenceLogger.info(
              "Signing key persistence succeeded.",
              {
                event: "signing_key_persistence_rotated",
                signingKeyId: replacement.id,
              },
            );
          },
        ),
        revokeManaged: Effect.fn("SigningKeyRepository.revokeManaged")(
          function* (userId, id, revokedAt) {
            const result = yield* Effect.tryPromise({
              try: () => revokeStatement(userId, id, revokedAt, null).run(),
              catch: unavailable("settings.signingKeys.revokeManaged"),
            });
            if (result.meta.changes !== 1) {
              return yield* new SigningKeyNotFound();
            }
            settingsPersistenceLogger.info(
              "Signing key persistence succeeded.",
              { event: "signing_key_persistence_revoked", signingKeyId: id },
            );
          },
        ),
        listVerification: Effect.fn("SigningKeyRepository.listVerification")(
          function* (userId) {
            const result = yield* Effect.tryPromise({
              try: () =>
                db
                  .prepare(
                    `SELECT id, user_id, name, public_key, fingerprint, created_at
                     FROM personal_verification_key
                     WHERE user_id = ? AND status = 'active'
                     ORDER BY created_at DESC, id DESC`,
                  )
                  .bind(userId)
                  .all(),
              catch: unavailable("settings.signingKeys.listVerification"),
            });
            const rows = yield* Schema.decodeUnknownEffect(
              Schema.Array(VerificationKeyRow),
            )(result.results);
            return yield* Effect.all(rows.map(decodeVerification));
          },
        ),
        insertVerification: Effect.fn(
          "SigningKeyRepository.insertVerification",
        )(function* (key) {
          const result = yield* Effect.result(
            Effect.tryPromise({
              try: () =>
                db
                  .prepare(
                    `INSERT INTO personal_verification_key (
                       id, user_id, name, algorithm, public_key, fingerprint,
                       status, created_at
                     ) VALUES (?, ?, ?, 'ssh-ed25519', ?, ?, 'active', ?)`,
                  )
                  .bind(
                    key.id,
                    key.userId,
                    key.name,
                    key.publicKey,
                    key.fingerprint,
                    encodedTimestamp(key.createdAt),
                  )
                  .run(),
              catch: unavailable("settings.signingKeys.insertVerification"),
            }),
          );
          if (Result.isFailure(result)) {
            const outcome = yield* findVerificationInsertOutcome(key);
            if (outcome === "missing") return yield* result.failure;
            if (outcome === "conflict") return yield* new SigningKeyConflict();
          }
          settingsPersistenceLogger.info(
            "Verification key persistence succeeded.",
            {
              event: "verification_key_persistence_created",
              verificationKeyId: key.id,
            },
          );
        }),
        revokeVerification: Effect.fn(
          "SigningKeyRepository.revokeVerification",
        )(function* (userId, id: VerificationKeyId, revokedAt) {
          const result = yield* Effect.tryPromise({
            try: () =>
              db
                .prepare(
                  `UPDATE personal_verification_key
                   SET status = 'revoked', revoked_at = ?
                   WHERE user_id = ? AND id = ? AND status = 'active'`,
                )
                .bind(encodedTimestamp(revokedAt), userId, id)
                .run(),
            catch: unavailable("settings.signingKeys.revokeVerification"),
          });
          if (result.meta.changes !== 1) {
            return yield* new SigningKeyNotFound();
          }
          settingsPersistenceLogger.info(
            "Verification key persistence succeeded.",
            {
              event: "verification_key_persistence_revoked",
              verificationKeyId: id,
            },
          );
        }),
      });
    }),
  );
