import {
  EnvironmentVariableEnvelope,
  EnvironmentVariableId,
  type IntegrationCredentialConfigReference,
  type IntegrationOwner,
  integrationCredentialReferenceFor,
} from "@dx/domain";
import { Context, Effect, Layer, Schema } from "effect";
import { settingsPersistenceLogger } from "../../logging.js";
import {
  type ConfigEncryptionKeyring,
  ConfigEncryptionUnavailable,
  decryptConfigValue,
  encryptConfigValue,
} from "../config-encryption.js";

export type IntegrationCredentialPurpose =
  | "access-token"
  | "refresh-token"
  | "pkce-verifier";

class IntegrationCredentialNotFound extends Schema.TaggedError<IntegrationCredentialNotFound>()(
  "IntegrationCredentialNotFound",
  {},
) {}

const CredentialRow = Schema.Struct({
  id: Schema.String,
  owner_scope: Schema.String,
  owner_id: Schema.String,
  purpose: Schema.String,
  envelope_version: Schema.Number,
  key_version: Schema.Number,
  value_nonce: Schema.String,
  ciphertext: Schema.String,
  wrapped_key_nonce: Schema.String,
  wrapped_key: Schema.String,
});

const aadFor = (
  id: string,
  owner: IntegrationOwner,
  purpose: IntegrationCredentialPurpose,
) => ({
  purpose: "integration-credential",
  id,
  ownerScope: owner.scope,
  ownerId: owner.id,
  credentialPurpose: purpose,
});

const referenceId = (reference: IntegrationCredentialConfigReference) =>
  reference.id;

export interface IntegrationCredentialVaultShape {
  readonly put: (
    keyring: ConfigEncryptionKeyring,
    owner: IntegrationOwner,
    purpose: IntegrationCredentialPurpose,
    plaintext: string,
  ) => Effect.Effect<IntegrationCredentialConfigReference, unknown>;
  readonly read: (
    keyring: ConfigEncryptionKeyring,
    owner: IntegrationOwner,
    purpose: IntegrationCredentialPurpose,
    reference: IntegrationCredentialConfigReference,
  ) => Effect.Effect<string, unknown>;
  readonly remove: (
    owner: IntegrationOwner,
    reference: IntegrationCredentialConfigReference,
  ) => Effect.Effect<void, unknown>;
}

export class IntegrationCredentialVault extends Context.Service<
  IntegrationCredentialVault,
  IntegrationCredentialVaultShape
>()("@dx/core/settings/integrations/IntegrationCredentialVault") {}

export const IntegrationCredentialVaultD1 = (db: D1Database) =>
  Layer.succeed(
    IntegrationCredentialVault,
    IntegrationCredentialVault.of({
      put: Effect.fn("IntegrationCredentialVault.put")(
        function* (keyring, owner, purpose, plaintext) {
          if (plaintext.length === 0 || plaintext.length > 32_768) {
            return yield* new ConfigEncryptionUnavailable();
          }
          const id = yield* Schema.decodeUnknownEffect(EnvironmentVariableId)(
            `icr_${crypto.randomUUID()}`,
          );
          const envelope = yield* encryptConfigValue(
            keyring,
            aadFor(id, owner, purpose),
            plaintext,
          );
          const now = new Date().toISOString();
          yield* Effect.tryPromise({
            try: () =>
              db
                .prepare(
                  `INSERT INTO integration_credential (
                   id, owner_scope, owner_id, purpose, envelope_version,
                   key_version, value_nonce, ciphertext, wrapped_key_nonce,
                   wrapped_key, created_at, rotated_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                )
                .bind(
                  id,
                  owner.scope,
                  owner.id,
                  purpose,
                  envelope.version,
                  envelope.keyVersion,
                  envelope.valueNonce,
                  envelope.ciphertext,
                  envelope.wrappedKeyNonce,
                  envelope.wrappedKey,
                  now,
                  now,
                )
                .run(),
            catch: () => new ConfigEncryptionUnavailable(),
          });
          return integrationCredentialReferenceFor(id);
        },
      ),
      read: Effect.fn("IntegrationCredentialVault.read")(
        function* (keyring, owner, purpose, reference) {
          const id = referenceId(reference);
          const result = yield* Effect.tryPromise({
            try: () =>
              db
                .prepare(
                  `SELECT id, owner_scope, owner_id, purpose, envelope_version,
                        key_version, value_nonce, ciphertext, wrapped_key_nonce,
                        wrapped_key
                   FROM integration_credential
                  WHERE id = ? AND owner_scope = ? AND owner_id = ? AND purpose = ?`,
                )
                .bind(id, owner.scope, owner.id, purpose)
                .all(),
            catch: () => new ConfigEncryptionUnavailable(),
          });
          const rows = yield* Schema.decodeUnknownEffect(
            Schema.Array(CredentialRow),
          )(result.results);
          const row = rows[0];
          if (row === undefined)
            return yield* new IntegrationCredentialNotFound();
          const envelope = yield* Schema.decodeUnknownEffect(
            EnvironmentVariableEnvelope,
          )({
            version: row.envelope_version,
            keyVersion: row.key_version,
            valueNonce: row.value_nonce,
            ciphertext: row.ciphertext,
            wrappedKeyNonce: row.wrapped_key_nonce,
            wrappedKey: row.wrapped_key,
          });
          return yield* decryptConfigValue(
            keyring,
            aadFor(id, owner, purpose),
            envelope,
          );
        },
      ),
      remove: Effect.fn("IntegrationCredentialVault.remove")(
        function* (owner, reference) {
          const id = referenceId(reference);
          yield* Effect.tryPromise({
            try: () =>
              db
                .prepare(
                  "DELETE FROM integration_credential WHERE id = ? AND owner_scope = ? AND owner_id = ?",
                )
                .bind(id, owner.scope, owner.id)
                .run(),
            catch: () => new ConfigEncryptionUnavailable(),
          });
          settingsPersistenceLogger.info(
            "Integration credential reference removed.",
            {
              event: "integration_credential_removed",
              credentialReferenceId: id,
              scope: owner.scope,
            },
          );
        },
      ),
    }),
  );
