import type { McpServerId, McpServerTarget } from "@dx/domain";
import { Effect, Schema } from "effect";
import {
  type ConfigEncryptionKeyring,
  type ConfigValueEnvelope,
  decryptConfigValue,
  encryptConfigValue,
} from "../config-encryption.js";

/**
 * Encrypted MCP values other than the bearer token (see `credential.ts`):
 * secret header values, an own OAuth app's client secret, per-person OAuth
 * grants, and pending sign-ins. None of them is ever part of a Thread
 * sandbox environment; only Core's MCP path reads them. Every envelope binds
 * its server, scope, and purpose, so a value cannot be replayed elsewhere.
 */
interface SecretOwner {
  readonly id: McpServerId;
  readonly target: McpServerTarget;
}

const EnvelopeRow = Schema.Struct({
  key_version: Schema.Int,
  value_nonce: Schema.String,
  ciphertext: Schema.String,
  wrapped_key_nonce: Schema.String,
  wrapped_key: Schema.String,
});

const envelopeOf = (row: unknown): ConfigValueEnvelope => {
  const decoded = Schema.decodeUnknownSync(EnvelopeRow)(row);
  return {
    version: 1,
    keyVersion: decoded.key_version,
    valueNonce: decoded.value_nonce,
    ciphertext: decoded.ciphertext,
    wrappedKeyNonce: decoded.wrapped_key_nonce,
    wrappedKey: decoded.wrapped_key,
  };
};

const encrypt = (
  keyring: ConfigEncryptionKeyring,
  context: Record<string, string>,
  value: string,
) => Effect.runPromise(encryptConfigValue(keyring, context, value));

const decrypt = (
  keyring: ConfigEncryptionKeyring,
  context: Record<string, string>,
  row: unknown,
) => Effect.runPromise(decryptConfigValue(keyring, context, envelopeOf(row)));

const envelopeColumns =
  "key_version, value_nonce, ciphertext, wrapped_key_nonce, wrapped_key";

/** `header:<lowercase name>` or `oauth-client-secret`. */
export type McpServerSecretName = `header:${string}` | "oauth-client-secret";

export const mcpHeaderSecretName = (header: string): McpServerSecretName =>
  `header:${header.toLowerCase()}`;

const secretContext = (server: SecretOwner, name: string) => ({
  id: server.id,
  scope: server.target.scope,
  targetId: server.target.id,
  kind: "mcp-server-secret",
  name,
});

export const putMcpServerSecret = async (
  db: D1Database,
  keyring: ConfigEncryptionKeyring,
  server: SecretOwner,
  name: McpServerSecretName,
  value: string,
  now: string,
) => {
  const envelope = await encrypt(keyring, secretContext(server, name), value);
  await db
    .prepare(
      `INSERT INTO mcp_server_secret (
         server_id, name, scope, target_id, envelope_version, ${envelopeColumns},
         created_at, rotated_at
       ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (server_id, name) DO UPDATE SET
         key_version = excluded.key_version,
         value_nonce = excluded.value_nonce,
         ciphertext = excluded.ciphertext,
         wrapped_key_nonce = excluded.wrapped_key_nonce,
         wrapped_key = excluded.wrapped_key,
         rotated_at = excluded.rotated_at`,
    )
    .bind(
      server.id,
      name,
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

/** Removes the named secrets, or every secret except `keep`. */
export const removeMcpServerSecrets = async (
  db: D1Database,
  server: SecretOwner,
  selection:
    | { readonly names: ReadonlyArray<McpServerSecretName> }
    | { readonly keep: ReadonlyArray<McpServerSecretName> },
) => {
  const names = "names" in selection ? selection.names : selection.keep;
  if ("names" in selection && names.length === 0) return;
  const placeholders = names.map(() => "?").join(", ");
  const filter =
    "names" in selection
      ? `AND name IN (${placeholders})`
      : names.length === 0
        ? ""
        : `AND name NOT IN (${placeholders})`;
  await db
    .prepare(
      `DELETE FROM mcp_server_secret
        WHERE server_id = ? AND scope = ? AND target_id = ? ${filter}`,
    )
    .bind(server.id, server.target.scope, server.target.id, ...names)
    .run();
};

export const listMcpServerSecretNames = async (
  db: D1Database,
  server: SecretOwner,
): Promise<ReadonlyArray<string>> => {
  const result = await db
    .prepare(
      `SELECT name FROM mcp_server_secret
        WHERE server_id = ? AND scope = ? AND target_id = ?
        ORDER BY name`,
    )
    .bind(server.id, server.target.scope, server.target.id)
    .all<{ name: string }>();
  return result.results.map(({ name }) => name);
};

/**
 * Every stored secret of the server by name. A value that fails to decrypt
 * throws: callers fail closed rather than call without it.
 */
export const readMcpServerSecrets = async (
  db: D1Database,
  keyring: ConfigEncryptionKeyring,
  server: SecretOwner,
): Promise<ReadonlyMap<string, string>> => {
  const result = await db
    .prepare(
      `SELECT name, ${envelopeColumns} FROM mcp_server_secret
        WHERE server_id = ? AND scope = ? AND target_id = ?`,
    )
    .bind(server.id, server.target.scope, server.target.id)
    .all<{ name: string }>();
  const entries = await Promise.all(
    result.results.map(
      async (row) =>
        [
          row.name,
          await decrypt(keyring, secretContext(server, row.name), row),
        ] as const,
    ),
  );
  return new Map(entries);
};

/** One person's OAuth sign-in to one server. */
export interface McpOAuthGrantPayload {
  readonly authorizationServerUrl: string;
  /** Authorization server metadata as discovered, for token refresh. */
  readonly metadata?: unknown;
  readonly resource?: string;
  readonly clientInformation: {
    readonly client_id: string;
    readonly client_secret?: string;
    readonly [key: string]: unknown;
  };
  readonly tokens: {
    readonly access_token: string;
    readonly token_type: string;
    readonly refresh_token?: string;
    readonly expires_in?: number;
    readonly scope?: string;
    readonly [key: string]: unknown;
  };
}

export interface McpOAuthGrant {
  readonly version: number;
  readonly endpoint: string;
  readonly accessExpiresAt?: string;
  readonly payload: McpOAuthGrantPayload;
}

const grantContext = (server: SecretOwner, userId: string) => ({
  id: server.id,
  scope: server.target.scope,
  targetId: server.target.id,
  userId,
  kind: "mcp-oauth-grant",
});

export const readMcpOAuthGrant = async (
  db: D1Database,
  keyring: ConfigEncryptionKeyring,
  server: SecretOwner,
  userId: string,
): Promise<McpOAuthGrant | undefined> => {
  const row = await db
    .prepare(
      `SELECT grant_row.version, grant_row.endpoint, grant_row.access_expires_at,
              ${envelopeColumns
                .split(", ")
                .map((column) => `grant_row.${column}`)
                .join(", ")}
         FROM mcp_oauth_grant grant_row
         JOIN mcp_server ON mcp_server.id = grant_row.server_id
        WHERE grant_row.server_id = ? AND grant_row.user_id = ?
          AND mcp_server.scope = ? AND mcp_server.target_id = ?`,
    )
    .bind(server.id, userId, server.target.scope, server.target.id)
    .first<{
      version: number;
      endpoint: string;
      access_expires_at: string | null;
    }>();
  if (row === null) return undefined;
  const payload = JSON.parse(
    await decrypt(keyring, grantContext(server, userId), row),
  ) as McpOAuthGrantPayload;
  return {
    version: row.version,
    endpoint: row.endpoint,
    ...(row.access_expires_at === null
      ? {}
      : { accessExpiresAt: row.access_expires_at }),
    payload,
  };
};

const accessExpiresAt = (payload: McpOAuthGrantPayload, now: Date) =>
  typeof payload.tokens.expires_in === "number" &&
  Number.isFinite(payload.tokens.expires_in) &&
  payload.tokens.expires_in > 0
    ? new Date(now.getTime() + payload.tokens.expires_in * 1_000).toISOString()
    : null;

/**
 * Stores a grant. With `expectedVersion` it only replaces that version and
 * returns false when another writer got there first; without it, it replaces
 * whatever was stored (a fresh sign-in).
 */
export const putMcpOAuthGrant = async (
  db: D1Database,
  keyring: ConfigEncryptionKeyring,
  server: SecretOwner,
  userId: string,
  endpoint: string,
  payload: McpOAuthGrantPayload,
  now: Date,
  expectedVersion?: number,
): Promise<boolean> => {
  const envelope = await encrypt(
    keyring,
    grantContext(server, userId),
    JSON.stringify(payload),
  );
  const values = [
    envelope.keyVersion,
    envelope.valueNonce,
    envelope.ciphertext,
    envelope.wrappedKeyNonce,
    envelope.wrappedKey,
    accessExpiresAt(payload, now),
    now.toISOString(),
  ];
  if (expectedVersion !== undefined) {
    const result = await db
      .prepare(
        `UPDATE mcp_oauth_grant
            SET version = version + 1, key_version = ?, value_nonce = ?,
                ciphertext = ?, wrapped_key_nonce = ?, wrapped_key = ?,
                access_expires_at = ?, updated_at = ?
          WHERE server_id = ? AND user_id = ? AND version = ? AND endpoint = ?`,
      )
      .bind(...values, server.id, userId, expectedVersion, endpoint)
      .run();
    return result.meta.changes === 1;
  }
  await db
    .prepare(
      `INSERT INTO mcp_oauth_grant (
         server_id, user_id, endpoint, version, envelope_version,
         ${envelopeColumns}, access_expires_at, created_at, updated_at
       ) VALUES (?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (server_id, user_id) DO UPDATE SET
         endpoint = excluded.endpoint,
         version = mcp_oauth_grant.version + 1,
         key_version = excluded.key_version,
         value_nonce = excluded.value_nonce,
         ciphertext = excluded.ciphertext,
         wrapped_key_nonce = excluded.wrapped_key_nonce,
         wrapped_key = excluded.wrapped_key,
         access_expires_at = excluded.access_expires_at,
         updated_at = excluded.updated_at`,
    )
    .bind(
      server.id,
      userId,
      endpoint,
      ...values.slice(0, 6),
      values[6],
      values[6],
    )
    .run();
  return true;
};

/** Removes one person's grant, or every grant on the server. */
export const removeMcpOAuthGrants = async (
  db: D1Database,
  serverId: McpServerId,
  userId?: string,
) => {
  await (userId === undefined
    ? db
        .prepare("DELETE FROM mcp_oauth_grant WHERE server_id = ?")
        .bind(serverId)
    : db
        .prepare(
          "DELETE FROM mcp_oauth_grant WHERE server_id = ? AND user_id = ?",
        )
        .bind(serverId, userId)
  ).run();
};

/** The servers among `serverIds` this person has signed in to. */
export const signedInMcpServerIds = async (
  db: D1Database,
  userId: string,
  serverIds: ReadonlyArray<string>,
): Promise<ReadonlySet<string>> => {
  if (serverIds.length === 0) return new Set();
  const result = await db
    .prepare(
      `SELECT grant_row.server_id FROM mcp_oauth_grant grant_row
         JOIN mcp_server ON mcp_server.id = grant_row.server_id
        WHERE grant_row.user_id = ?
          AND grant_row.endpoint = mcp_server.endpoint
          AND grant_row.server_id IN (${serverIds.map(() => "?").join(", ")})`,
    )
    .bind(userId, ...serverIds)
    .all<{ server_id: string }>();
  return new Set(result.results.map(({ server_id }) => server_id));
};

/** What a pending sign-in needs to finish. */
export interface McpOAuthTransactionPayload {
  readonly codeVerifier: string;
  readonly redirectUrl: string;
  readonly authorizationServerUrl: string;
  readonly metadata?: unknown;
  readonly resource?: string;
  readonly clientInformation: McpOAuthGrantPayload["clientInformation"];
}

export interface McpOAuthTransaction {
  readonly id: string;
  readonly serverId: McpServerId;
  readonly endpoint: string;
  readonly returnTo: string;
  readonly payload: McpOAuthTransactionPayload;
}

const transactionContext = (id: string, serverId: string, userId: string) => ({
  id,
  serverId,
  userId,
  kind: "mcp-oauth-transaction",
});

export const MCP_OAUTH_TRANSACTION_TTL_MS = 10 * 60 * 1_000;

export const insertMcpOAuthTransaction = async (
  db: D1Database,
  keyring: ConfigEncryptionKeyring,
  input: {
    readonly stateHash: string;
    readonly serverId: McpServerId;
    readonly userId: string;
    readonly browserSessionId: string;
    readonly endpoint: string;
    readonly returnTo: string;
    readonly payload: McpOAuthTransactionPayload;
    readonly now: Date;
  },
) => {
  const id = `mot_${crypto.randomUUID()}`;
  const envelope = await encrypt(
    keyring,
    transactionContext(id, input.serverId, input.userId),
    JSON.stringify(input.payload),
  );
  await db.batch([
    // Expired sign-ins are swept whenever a new one starts.
    db
      .prepare("DELETE FROM mcp_oauth_transaction WHERE expires_at < ?")
      .bind(input.now.toISOString()),
    db
      .prepare(
        `INSERT INTO mcp_oauth_transaction (
           id, state_hash, server_id, user_id, browser_session_id, endpoint,
           return_to, envelope_version, ${envelopeColumns}, expires_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        input.stateHash,
        input.serverId,
        input.userId,
        input.browserSessionId,
        input.endpoint,
        input.returnTo,
        envelope.keyVersion,
        envelope.valueNonce,
        envelope.ciphertext,
        envelope.wrappedKeyNonce,
        envelope.wrappedKey,
        new Date(
          input.now.getTime() + MCP_OAUTH_TRANSACTION_TTL_MS,
        ).toISOString(),
        input.now.toISOString(),
      ),
  ]);
};

/**
 * Deletes and returns the pending sign-in for this state, person, and
 * browser session; undefined when none matches or it expired. Deleting
 * first makes every state single use.
 */
export const consumeMcpOAuthTransaction = async (
  db: D1Database,
  keyring: ConfigEncryptionKeyring,
  stateHash: string,
  userId: string,
  browserSessionId: string,
  now: Date,
): Promise<McpOAuthTransaction | undefined> => {
  const row = await db
    .prepare(
      `DELETE FROM mcp_oauth_transaction
        WHERE state_hash = ?
        RETURNING id, server_id, user_id, browser_session_id, endpoint,
                  return_to, expires_at, ${envelopeColumns}`,
    )
    .bind(stateHash)
    .first<{
      id: string;
      server_id: string;
      user_id: string;
      browser_session_id: string;
      endpoint: string;
      return_to: string;
      expires_at: string;
    }>();
  if (
    row === null ||
    row.user_id !== userId ||
    row.browser_session_id !== browserSessionId ||
    row.expires_at < now.toISOString()
  ) {
    return undefined;
  }
  const payload = JSON.parse(
    await decrypt(
      keyring,
      transactionContext(row.id, row.server_id, row.user_id),
      row,
    ),
  ) as McpOAuthTransactionPayload;
  return {
    id: row.id,
    serverId: row.server_id as McpServerId,
    endpoint: row.endpoint,
    returnTo: row.return_to,
    payload,
  };
};
