import type { McpServerId, McpServerTarget } from "@dx/domain";
import { Effect, Schema } from "effect";
import {
  type ConfigEncryptionKeyring,
  decryptConfigValue,
  encryptConfigValue,
} from "../config-encryption.js";

/**
 * Bearer tokens entered on an MCP server. They live in
 * `mcp_server_credential`, never in `environment_variable`, so they are not
 * part of any Thread sandbox environment; only Core's MCP path reads them.
 * The envelope binds the server and its scope, so a token cannot be replayed
 * on another server or as an environment-variable secret.
 */
interface CredentialOwner {
  readonly id: McpServerId;
  readonly target: McpServerTarget;
}

const additionalData = (server: CredentialOwner) => ({
  id: server.id,
  scope: server.target.scope,
  targetId: server.target.id,
  kind: "mcp-server-credential",
});

const CredentialRow = Schema.Struct({
  key_version: Schema.Int,
  value_nonce: Schema.String,
  ciphertext: Schema.String,
  wrapped_key_nonce: Schema.String,
  wrapped_key: Schema.String,
});

/** Insert or rotate the server's token. */
export const putMcpServerCredential = async (
  db: D1Database,
  keyring: ConfigEncryptionKeyring,
  server: CredentialOwner,
  token: string,
  now: string,
) => {
  const envelope = await Effect.runPromise(
    encryptConfigValue(keyring, additionalData(server), token),
  );
  await db
    .prepare(
      `INSERT INTO mcp_server_credential (
         server_id, scope, target_id, envelope_version, key_version,
         value_nonce, ciphertext, wrapped_key_nonce, wrapped_key,
         created_at, rotated_at
       ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (server_id) DO UPDATE SET
         key_version = excluded.key_version,
         value_nonce = excluded.value_nonce,
         ciphertext = excluded.ciphertext,
         wrapped_key_nonce = excluded.wrapped_key_nonce,
         wrapped_key = excluded.wrapped_key,
         rotated_at = excluded.rotated_at`,
    )
    .bind(
      server.id,
      server.target.scope,
      server.target.id,
      envelope.keyVersion,
      envelope.valueNonce,
      envelope.ciphertext,
      envelope.wrappedKeyNonce,
      envelope.wrappedKey,
      now,
      now,
    )
    .run();
};

export const removeMcpServerCredential = async (
  db: D1Database,
  server: CredentialOwner,
) => {
  await db
    .prepare(
      "DELETE FROM mcp_server_credential WHERE server_id = ? AND scope = ? AND target_id = ?",
    )
    .bind(server.id, server.target.scope, server.target.id)
    .run();
};

/**
 * The server's token, or `undefined` when none is stored. A stored token that
 * fails to decrypt throws: callers fail closed rather than call unauthenticated.
 */
export const readMcpServerCredential = async (
  db: D1Database,
  keyring: ConfigEncryptionKeyring,
  server: CredentialOwner,
): Promise<string | undefined> => {
  const row = await db
    .prepare(
      `SELECT key_version, value_nonce, ciphertext, wrapped_key_nonce, wrapped_key
         FROM mcp_server_credential
        WHERE server_id = ? AND scope = ? AND target_id = ?`,
    )
    .bind(server.id, server.target.scope, server.target.id)
    .first();
  if (row === null) return undefined;
  const credential = Schema.decodeUnknownSync(CredentialRow)(row);
  return Effect.runPromise(
    decryptConfigValue(keyring, additionalData(server), {
      version: 1,
      keyVersion: credential.key_version,
      valueNonce: credential.value_nonce,
      ciphertext: credential.ciphertext,
      wrappedKeyNonce: credential.wrapped_key_nonce,
      wrappedKey: credential.wrapped_key,
    }),
  );
};
