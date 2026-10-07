import { createHash } from "node:crypto";
import { ThreadId, UserId } from "@dx/domain";
import { Effect, Option, Redacted, Schema } from "effect";
import type { Bindings } from "../http/types.js";
import { threadProjectReachableSql } from "../settings/members/membership-sql.js";
import { createAuth } from "./better-auth.js";
import { loadAuthenticationRequirements } from "./requirements.js";

const DAEMON_KEY_CONFIG = "daemon-keys";

const DaemonKeyMetadata = Schema.Struct({
  version: Schema.Literal(1),
  threadId: ThreadId,
});

export const threadDaemonBearer = (header: string | null) => {
  const match = /^Bearer (dxd_[A-Za-z0-9._~-]{16,1016})$/.exec(header ?? "");
  return match?.[1];
};
const bearer = threadDaemonBearer;

/**
 * SHA-256 of a daemon key, hex. The Thread execution object keeps it with the
 * authority so a registration is checked without D1.
 */
export const threadDaemonApiKeyHash = (key: string) =>
  createHash("sha256").update(key).digest("hex");

const database = (bindings: Bindings) => {
  if (bindings.DB === undefined) throw new Error("D1 database is unavailable.");
  return bindings.DB;
};

const activeThreadOwner = async (bindings: Bindings, threadId: ThreadId) => {
  const row = await database(bindings)
    .prepare(
      `SELECT owner_user_id
         FROM threads
        WHERE id = ? AND lifecycle_state = 'active'`,
    )
    .bind(threadId)
    .first<{ readonly owner_user_id: string }>();
  if (row === null) throw new Error("Active Thread is unavailable.");
  return Schema.decodeUnknownSync(UserId)(row.owner_user_id);
};

export const mintThreadDaemonApiKey = async (
  bindings: Bindings,
  threadId: ThreadId,
) => {
  const ownerUserId = await activeThreadOwner(bindings, threadId);
  const requirements = await Effect.runPromise(
    loadAuthenticationRequirements(bindings),
  );
  const created = await createAuth(bindings, requirements).api.createApiKey({
    body: {
      configId: DAEMON_KEY_CONFIG,
      name: "Thread dxd",
      userId: ownerUserId,
      metadata: { version: 1, threadId },
      permissions: {},
    },
  });
  return {
    id: created.id,
    key: Redacted.make(created.key),
  };
};

export const verifyThreadDaemonApiKey = async (
  bindings: Bindings,
  threadId: ThreadId,
  authorization: string | null,
): Promise<{ readonly keyId: string } | undefined> => {
  const key = bearer(authorization);
  if (key === undefined) return undefined;
  const requirements = await Effect.runPromise(
    loadAuthenticationRequirements(bindings),
  );
  const verified = await createAuth(bindings, requirements).api.verifyApiKey({
    body: { configId: DAEMON_KEY_CONFIG, key },
  });
  if (
    !verified.valid ||
    verified.key === null ||
    verified.key.configId !== DAEMON_KEY_CONFIG
  )
    return undefined;
  const metadata = Schema.decodeUnknownOption(DaemonKeyMetadata)(
    verified.key.metadata,
  );
  if (Option.isNone(metadata) || metadata.value.threadId !== threadId)
    return undefined;
  const owner = await database(bindings)
    .prepare(
      `SELECT 1 AS owned
         FROM threads
         JOIN projects ON projects.id = threads.project_id
        WHERE threads.id = ? AND threads.owner_user_id = ?
          AND threads.lifecycle_state = 'active'
          AND ${threadProjectReachableSql("projects", "threads.owner_user_id")}`,
    )
    .bind(threadId, verified.key.referenceId)
    .first<{ readonly owned: number }>();
  return owner?.owned === 1 ? { keyId: verified.key.id } : undefined;
};

/**
 * One read that confirms what `verifyThreadDaemonApiKey` would: the key row
 * still exists (not revoked), is enabled and unexpired, and belongs to the
 * owner of this active Thread. It runs behind a registration the Thread
 * execution object already admitted by the key's hash.
 */
export const confirmThreadDaemonApiKey = async (
  bindings: Bindings,
  threadId: ThreadId,
  keyId: string,
) => {
  const row = await database(bindings)
    .prepare(
      `SELECT 1 AS owned
         FROM apikey
         JOIN threads ON threads.owner_user_id = apikey.referenceId
         JOIN projects ON projects.id = threads.project_id
        WHERE apikey.id = ?
          AND apikey.configId = ?
          AND (apikey.enabled IS NULL OR apikey.enabled = 1)
          AND apikey.expiresAt IS NULL
          AND threads.id = ?
          AND threads.lifecycle_state = 'active'
          AND ${threadProjectReachableSql("projects", "threads.owner_user_id")}`,
    )
    .bind(keyId, DAEMON_KEY_CONFIG, threadId)
    .first<{ readonly owned: number }>();
  return row?.owned === 1;
};

export const revokeThreadDaemonApiKey = async (
  bindings: Bindings,
  keyId: string | undefined,
) => {
  if (keyId === undefined) return;
  await database(bindings)
    .prepare("DELETE FROM apikey WHERE id = ? AND configId = ?")
    .bind(keyId, DAEMON_KEY_CONFIG)
    .run();
};
