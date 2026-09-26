import {
  EnvironmentVariableId,
  ModelConnectionTarget,
  type StoredModelConnection,
} from "@dx/domain";
import { Effect, Schema } from "effect";
import { settingsPersistenceLogger } from "../../logging.js";
import type { ConfigEncryptionKeyring } from "../config-encryption.js";
import { decryptModelCredential } from "./model-credential-encryption.js";

const CredentialRow = Schema.Struct({
  id: Schema.String,
  scope: Schema.String,
  target_id: Schema.String,
  name: Schema.String,
  key_version: Schema.Int,
  value_nonce: Schema.String,
  ciphertext: Schema.String,
  wrapped_key_nonce: Schema.String,
  wrapped_key: Schema.String,
});

/** Load only ciphertext and its authenticated context, fenced to the connection owner. */
export const loadConnectionCredential = async (
  db: D1Database,
  connection: StoredModelConnection,
) => {
  const credentialId = connection.credentialId;
  if (credentialId === undefined) return undefined;
  const row = await db
    .prepare(
      `SELECT id, scope, target_id, name, key_version,
              value_nonce, ciphertext, wrapped_key_nonce, wrapped_key
       FROM model_credential
       WHERE id = ? AND scope = ? AND target_id = ?`,
    )
    .bind(credentialId, connection.target.scope, connection.target.id)
    .first();
  if (row === null) return undefined;
  return Schema.decodeUnknownSync(CredentialRow)(row);
};

export const decryptConnectionCredential = async (
  keyring: ConfigEncryptionKeyring,
  credential: typeof CredentialRow.Type | undefined,
): Promise<string | undefined> => {
  if (credential === undefined) return undefined;
  const plaintext = await Effect.runPromise(
    decryptModelCredential(
      keyring,
      {
        id: Schema.decodeUnknownSync(EnvironmentVariableId)(credential.id),
        target: Schema.decodeUnknownSync(ModelConnectionTarget)({
          scope: credential.scope,
          id: credential.target_id,
        }),
        name: credential.name,
      },
      {
        version: 1,
        keyVersion: credential.key_version,
        valueNonce: credential.value_nonce,
        ciphertext: credential.ciphertext,
        wrappedKeyNonce: credential.wrapped_key_nonce,
        wrappedKey: credential.wrapped_key,
      },
    ),
  ).catch((error: unknown) => {
    settingsPersistenceLogger.warn("Model credential decrypt failed.", {
      event: "model_credential_decrypt_failed",
      error: String(error),
    });
    return undefined;
  });
  return plaintext;
};

export const connectionApiKey = async (
  db: D1Database,
  keyring: ConfigEncryptionKeyring,
  connection: StoredModelConnection,
) =>
  decryptConnectionCredential(
    keyring,
    await loadConnectionCredential(db, connection),
  );
