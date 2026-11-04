import {
  type IntegrationOwner,
  integrationCredentialReferenceFor,
  SourceControlAccessDenied,
  SourceControlProviderFailure,
} from "@dx/domain";
import { Effect, Schema } from "effect";
import type { Bindings } from "../../http/types.js";
import { sourceControlLogger } from "../../logging.js";
import {
  type ConfigEncryptionKeyring,
  loadConfigEncryptionKeyring,
} from "../../settings/config-encryption.js";
import {
  IntegrationCredentialVault,
  IntegrationCredentialVaultD1,
  type IntegrationCredentialVaultShape,
} from "../../settings/integrations/credential-vault.js";
import {
  createOAuthProof,
  hashOAuthState,
} from "../../settings/integrations/provider-registry.js";
import type { AuthorizedSource } from "../admission.js";
import { type SourceOwner, sourceAccessDenied } from "../authority.js";
import { loadBitbucketConfiguration } from "./configuration.js";
import {
  type BitbucketConfiguration,
  BitbucketProviderError,
  type BitbucketRepository,
  type BitbucketTokenSet,
  createBitbucketProvider,
} from "./provider-http.js";

export class BitbucketInvalid extends Schema.TaggedError<BitbucketInvalid>()(
  "BitbucketInvalid",
  {},
) {}
export interface BitbucketConnectionRow {
  id: string;
  user_id: string;
  provider_account_id: string;
  account_name: string;
  status: "active" | "reauthorization-required" | "disconnected";
  authorization_epoch: number;
  access_credential_id: string | null;
  refresh_credential_id: string | null;
  expires_at: string | null;
  refresh_lock_id: string | null;
  refresh_lock_until: string | null;
}
const owner = (userId: string): IntegrationOwner => ({
  scope: "personal",
  id: userId as never,
});
const reference = (id: string) =>
  integrationCredentialReferenceFor(id as never);
const now = () => new Date().toISOString();
/** Longer than a refresh can take: Bitbucket's 10 s fetch limit plus vault writes. */
const REFRESH_LOCK_MS = 30_000;
/** How long a request waits for another request's refresh to commit. */
const REFRESH_WAIT_MS = 15_000;
const REFRESH_POLL_MS = 200;
const denied = () =>
  sourceAccessDenied("connection-reauthorization-required", "reconnect");
const unavailable = () =>
  new BitbucketProviderError({ category: "unavailable" });

export const readBitbucketConnection = (
  db: D1Database,
  userId: string,
  id?: string,
) =>
  db
    .prepare(
      `SELECT * FROM bitbucket_connection WHERE user_id = ? ${id === undefined ? "AND status != 'disconnected'" : "AND id = ?"} ORDER BY updated_at DESC LIMIT 1`,
    )
    .bind(...(id === undefined ? [userId] : [userId, id]))
    .first<BitbucketConnectionRow>();

export const disconnectBitbucket = async (db: D1Database, userId: string) => {
  // One transaction stops all local authority even if Bitbucket is unreachable.
  await db.batch([
    db
      .prepare(
        "DELETE FROM integration_credential WHERE owner_scope = 'personal' AND owner_id = ? AND id IN (SELECT access_credential_id FROM bitbucket_connection WHERE user_id = ? UNION SELECT refresh_credential_id FROM bitbucket_connection WHERE user_id = ?)",
      )
      .bind(userId, userId, userId),
    db
      .prepare(
        "UPDATE bitbucket_connection SET status = 'disconnected', authorization_epoch = authorization_epoch + 1, access_credential_id = NULL, refresh_credential_id = NULL, refresh_lock_id = NULL, refresh_lock_until = NULL, updated_at = ? WHERE user_id = ? AND status != 'disconnected'",
      )
      .bind(now(), userId),
    db
      .prepare("DELETE FROM bitbucket_git_lease WHERE actor_user_id = ?")
      .bind(userId),
    db
      .prepare("DELETE FROM bitbucket_oauth_state WHERE user_id = ?")
      .bind(userId),
  ]);
};

export const createBitbucketControlPlane = (input: {
  db: D1Database;
  config: BitbucketConfiguration;
  keyring: ConfigEncryptionKeyring;
  vault: IntegrationCredentialVaultShape;
  fetcher?: typeof fetch;
}) => {
  const { db, vault, keyring } = input;
  const provider = createBitbucketProvider(input.config, input.fetcher);
  const read = (
    row: BitbucketConnectionRow,
    purpose: "access-token" | "refresh-token",
    id: string,
  ) =>
    Effect.runPromise(
      vault.read(keyring, owner(row.user_id), purpose, reference(id)),
    );
  const erase = (userId: string, ids: ReadonlyArray<string | null>) =>
    Promise.all(
      ids
        .filter((id): id is string => id !== null)
        .map((id) =>
          Effect.runPromise(vault.remove(owner(userId), reference(id))),
        ),
    );
  const store = async (userId: string, tokens: BitbucketTokenSet) => {
    const access = await Effect.runPromise(
      vault.put(keyring, owner(userId), "access-token", tokens.accessToken),
    );
    try {
      const refresh = await Effect.runPromise(
        vault.put(keyring, owner(userId), "refresh-token", tokens.refreshToken),
      );
      return { access: access.id, refresh: refresh.id };
    } catch (cause) {
      await erase(userId, [access.id]);
      throw cause;
    }
  };
  const invalidate = async (row: BitbucketConnectionRow) => {
    // Epoch guard prevents a delayed failure invalidating a later authorization.
    await db.batch([
      db
        .prepare(
          "DELETE FROM bitbucket_git_lease WHERE connection_id = ? AND authorization_epoch = ?",
        )
        .bind(row.id, row.authorization_epoch),
      db
        .prepare(
          "UPDATE bitbucket_connection SET status = 'reauthorization-required', authorization_epoch = authorization_epoch + 1, refresh_lock_id = NULL, refresh_lock_until = NULL, updated_at = ? WHERE id = ? AND status = 'active' AND authorization_epoch = ?",
        )
        .bind(now(), row.id, row.authorization_epoch),
    ]);
  };
  const active = async (userId: string, id?: string) => {
    const row = await readBitbucketConnection(db, userId, id);
    if (
      row?.status !== "active" ||
      !row.access_credential_id ||
      !row.refresh_credential_id
    )
      throw denied();
    return row;
  };
  const logRefresh = (
    row: BitbucketConnectionRow,
    outcome: "refreshed" | "retryable" | "refused",
    reason: string,
  ) => {
    const properties = {
      event: "bitbucket_token_refresh",
      connectionId: row.id,
      outcome,
      reason,
    };
    if (outcome === "refreshed")
      sourceControlLogger.info("Bitbucket token refresh settled.", properties);
    else
      sourceControlLogger.warn("Bitbucket token refresh settled.", properties);
  };
  const reasonOf = (cause: unknown) =>
    cause instanceof BitbucketProviderError
      ? cause.category
      : cause instanceof SourceControlAccessDenied
        ? cause.reason
        : "internal";
  /** Gives the lock back so the next use refreshes at once. Best effort: an
   * expired lock is taken over anyway. */
  const releaseLock = (row: BitbucketConnectionRow, lockId: string) =>
    db
      .prepare(
        "UPDATE bitbucket_connection SET refresh_lock_id = NULL, refresh_lock_until = NULL WHERE id = ? AND refresh_lock_id = ?",
      )
      .bind(row.id, lockId)
      .run()
      .catch(() => undefined);
  /**
   * Rotates the tokens under a lock this call holds. Only Bitbucket refusing
   * the refresh token (`invalid_grant`) ends the authorization. Anything else
   * — a network error, a 5xx, a rate limit, a vault or D1 failure — keeps the
   * stored credentials, releases the lock, and fails retryably: Bitbucket's
   * own answer to the next refresh settles whether the grant still stands.
   */
  const refresh = async (
    row: BitbucketConnectionRow,
    lockId: string,
  ): Promise<{ row: BitbucketConnectionRow; token: string }> => {
    let tokens: BitbucketTokenSet;
    let refs: { access: string; refresh: string };
    try {
      tokens = await provider.refreshToken(
        await read(row, "refresh-token", row.refresh_credential_id as string),
      );
    } catch (cause) {
      if (
        cause instanceof BitbucketProviderError &&
        cause.category === "invalid-grant"
      ) {
        logRefresh(row, "refused", cause.category);
        await invalidate(row);
        throw denied();
      }
      logRefresh(row, "retryable", reasonOf(cause));
      await releaseLock(row, lockId);
      throw cause instanceof BitbucketProviderError &&
        cause.category === "rate-limited"
        ? cause
        : unavailable();
    }
    try {
      refs = await store(row.user_id, tokens);
    } catch (cause) {
      logRefresh(row, "retryable", `store:${reasonOf(cause)}`);
      await releaseLock(row, lockId);
      throw unavailable();
    }
    let committed: boolean;
    try {
      const result = await db
        .prepare(
          "UPDATE bitbucket_connection SET access_credential_id = ?, refresh_credential_id = ?, expires_at = ?, refresh_lock_id = NULL, refresh_lock_until = NULL, updated_at = ? WHERE id = ? AND status = 'active' AND authorization_epoch = ? AND refresh_lock_id = ?",
        )
        .bind(
          refs.access,
          refs.refresh,
          tokens.expiresAt.toISOString(),
          now(),
          row.id,
          row.authorization_epoch,
          lockId,
        )
        .run();
      committed = result.meta.changes === 1;
    } catch {
      // A lost acknowledgement: what D1 now holds says whether it landed.
      const settled = await readBitbucketConnection(
        db,
        row.user_id,
        row.id,
      ).catch(() => undefined);
      if (settled === undefined) {
        // Unknown either way. Keep both credential sets; the lock expires
        // and the next use takes it over from whatever D1 holds.
        logRefresh(row, "retryable", "commit-unknown");
        throw unavailable();
      }
      committed = settled?.access_credential_id === refs.access;
      if (!committed) await releaseLock(row, lockId);
    }
    if (!committed) {
      await erase(row.user_id, [refs.access, refs.refresh]).catch(
        () => undefined,
      );
      const current = await readBitbucketConnection(db, row.user_id, row.id);
      // The authorization ended meanwhile (disconnect, reconnect, revoke).
      if (
        current?.status !== "active" ||
        current.authorization_epoch !== row.authorization_epoch
      )
        throw denied();
      logRefresh(row, "retryable", "commit");
      throw unavailable();
    }
    logRefresh(row, "refreshed", "expiring");
    // Reclaim superseded secrets before the fallible post-commit re-read.
    // Cleanup failure must not invalidate the active replacements.
    await erase(row.user_id, [
      row.access_credential_id,
      row.refresh_credential_id,
    ]).catch(() => undefined);
    try {
      return {
        row: await active(row.user_id, row.id),
        token: tokens.accessToken,
      };
    } catch (cause) {
      // A confirmed commit does not become invalid because a later read failed.
      if (cause instanceof SourceControlAccessDenied) throw cause;
      throw unavailable();
    }
  };
  /**
   * The connection's access token, refreshed when it is about to expire (or
   * when `stale` names the credential Bitbucket just refused). One request
   * refreshes at a time; the others wait for its commit instead of failing.
   * A lock that outlived its holder (a cancelled request or a crashed
   * isolate) is taken over: the stored refresh token is replayed, and
   * Bitbucket's answer decides whether the grant still stands.
   */
  const accessToken = async (
    initial: BitbucketConnectionRow,
    stale?: string,
  ): Promise<{
    row: BitbucketConnectionRow;
    token: string;
    refreshed: boolean;
  }> => {
    const deadline = Date.now() + REFRESH_WAIT_MS;
    let row = initial;
    while (true) {
      const lockHeld =
        row.refresh_lock_id !== null &&
        row.refresh_lock_until !== null &&
        row.refresh_lock_until > now();
      if (lockHeld) {
        if (Date.now() >= deadline) throw unavailable();
        await new Promise((resolve) => setTimeout(resolve, REFRESH_POLL_MS));
        row = await active(row.user_id, row.id);
        continue;
      }
      const usable =
        row.refresh_lock_id === null &&
        row.access_credential_id !== stale &&
        row.expires_at !== null &&
        Date.parse(row.expires_at) > Date.now() + 60_000;
      if (usable)
        return {
          row,
          token: await read(
            row,
            "access-token",
            row.access_credential_id as string,
          ),
          refreshed: false,
        };
      const lockId = crypto.randomUUID();
      const lock = await db
        .prepare(
          "UPDATE bitbucket_connection SET refresh_lock_id = ?, refresh_lock_until = ? WHERE id = ? AND status = 'active' AND authorization_epoch = ? AND access_credential_id = ? AND refresh_lock_id IS ?",
        )
        .bind(
          lockId,
          new Date(Date.now() + REFRESH_LOCK_MS).toISOString(),
          row.id,
          row.authorization_epoch,
          row.access_credential_id,
          row.refresh_lock_id,
        )
        .run();
      if (lock.meta.changes === 1) {
        if (row.refresh_lock_id !== null)
          logRefresh(row, "retryable", "abandoned-lock-taken-over");
        return { ...(await refresh(row, lockId)), refreshed: true };
      }
      // Another request locked or rotated first: read what it left.
      if (Date.now() >= deadline) throw unavailable();
      row = await active(row.user_id, row.id);
    }
  };
  const withConnection = async <A>(
    userId: string,
    connectionId: string | undefined,
    callback: (
      token: string,
      row: BitbucketConnectionRow,
      api: ReturnType<typeof createBitbucketProvider>,
    ) => Promise<A>,
    options: {
      /** The callback may run again after a refused token is refreshed. */
      readonly replayable?: boolean;
    } = {},
  ): Promise<A> => {
    let { row, token, refreshed } = await accessToken(
      await active(userId, connectionId),
    );
    for (let attempt = 0; ; attempt += 1) {
      try {
        const result = await callback(token, row, provider);
        const after = await active(userId, row.id);
        if (after.authorization_epoch !== row.authorization_epoch)
          throw denied();
        return result;
      } catch (cause) {
        if (
          !(cause instanceof BitbucketProviderError) ||
          (cause.category !== "unauthorized" &&
            cause.category !== "invalid-grant")
        )
          throw cause;
        // A token minted moments ago and still refused is a definite
        // refusal. An older one may have been rotated away: refresh it, and
        // let the refresh token's answer decide.
        if (refreshed || cause.category === "invalid-grant") {
          sourceControlLogger.warn("Bitbucket refused a fresh access token.", {
            event: "bitbucket_token_refresh",
            connectionId: row.id,
            outcome: "refused",
            reason: cause.category,
          });
          await invalidate(row);
          throw denied();
        }
        ({ row, token, refreshed } = await accessToken(
          await active(userId, row.id),
          row.access_credential_id ?? undefined,
        ));
        if (!options.replayable || attempt > 0) throw unavailable();
      }
    }
  };
  const cacheRepositoryStatement = (
    row: BitbucketConnectionRow,
    repo: BitbucketRepository,
  ) =>
    db
      .prepare(`INSERT INTO bitbucket_repository (connection_id, repository_id, workspace_id, full_name, web_url, clone_url, default_branch, visibility)
      SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM bitbucket_connection WHERE id = ? AND status = 'active' AND authorization_epoch = ?)
      ON CONFLICT(connection_id, repository_id) DO UPDATE SET workspace_id = excluded.workspace_id, full_name = excluded.full_name, web_url = excluded.web_url, clone_url = excluded.clone_url, default_branch = excluded.default_branch, visibility = excluded.visibility`)
      .bind(
        row.id,
        repo.id,
        repo.workspaceId,
        repo.fullName,
        repo.webUrl,
        repo.cloneUrl,
        repo.defaultBranch,
        repo.visibility,
        row.id,
        row.authorization_epoch,
      );
  const cacheRepository = async (
    row: BitbucketConnectionRow,
    repo: BitbucketRepository,
  ) => {
    await cacheRepositoryStatement(row, repo).run();
  };
  return {
    withConnection,
    cacheRepository,
    beginAuthorization: async (userId: string, sessionId: string) => {
      const proof = await createOAuthProof();
      await db.batch([
        db
          .prepare(
            "DELETE FROM bitbucket_oauth_state WHERE user_id = ? OR expires_at <= ?",
          )
          .bind(userId, now()),
        db
          .prepare(
            "INSERT INTO bitbucket_oauth_state (state_hash, user_id, session_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
          )
          .bind(
            await hashOAuthState(proof.state),
            userId,
            sessionId,
            new Date(Date.now() + 600_000).toISOString(),
            now(),
          ),
      ]);
      const url = new URL("https://bitbucket.org/site/oauth2/authorize");
      url.searchParams.set("client_id", input.config.clientId);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("state", proof.state);
      url.searchParams.set("redirect_uri", input.config.callbackUrl);
      return { authorizationUrl: url.href };
    },
    completeAuthorization: async (
      userId: string,
      sessionId: string,
      state: string,
      code?: string,
    ) => {
      if (
        !state ||
        state.length > 128 ||
        (code !== undefined && code.length > 2048)
      )
        throw new BitbucketInvalid();
      const stateHash = await hashOAuthState(state);
      const transaction = await db
        .prepare(
          "UPDATE bitbucket_oauth_state SET consumed_at = ? WHERE state_hash = ? AND user_id = ? AND session_id = ? AND expires_at > ? AND consumed_at IS NULL RETURNING state_hash",
        )
        .bind(now(), stateHash, userId, sessionId, now())
        .first();
      if (!transaction) throw new BitbucketInvalid();
      if (!code) return; // Denied consent leaves an existing connection untouched.
      const tokens = await provider.exchangeCode(code);
      const user = await provider.getUser(tokens.accessToken);
      if (!user.id || !user.login) throw new BitbucketInvalid();
      const old = await readBitbucketConnection(db, userId);
      const refs = await store(userId, tokens);
      const id = `bbc_${crypto.randomUUID()}`;
      const completedAt = now();
      try {
        const results = await db.batch([
          db
            .prepare(
              "UPDATE bitbucket_connection SET status = 'disconnected', authorization_epoch = authorization_epoch + 1, updated_at = ? WHERE user_id = ? AND status != 'disconnected' AND EXISTS (SELECT 1 FROM bitbucket_oauth_state WHERE state_hash = ? AND expires_at > ? AND consumed_at IS NOT NULL)",
            )
            .bind(completedAt, userId, stateHash, completedAt),
          db
            .prepare(
              "DELETE FROM bitbucket_git_lease WHERE actor_user_id = ? AND EXISTS (SELECT 1 FROM bitbucket_oauth_state WHERE state_hash = ? AND expires_at > ? AND consumed_at IS NOT NULL)",
            )
            .bind(userId, stateHash, completedAt),
          db
            .prepare(
              "INSERT INTO bitbucket_connection (id,user_id,provider_account_id,account_name,status,authorization_epoch,access_credential_id,refresh_credential_id,expires_at,created_at,updated_at) SELECT ?,?,?,?,'active',1,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM bitbucket_oauth_state WHERE state_hash = ? AND expires_at > ? AND consumed_at IS NOT NULL)",
            )
            .bind(
              id,
              userId,
              user.id,
              user.login,
              refs.access,
              refs.refresh,
              tokens.expiresAt.toISOString(),
              completedAt,
              completedAt,
              stateHash,
              completedAt,
            ),
          db
            .prepare("DELETE FROM bitbucket_oauth_state WHERE state_hash = ?")
            .bind(stateHash),
        ]);
        if (results[2]?.meta.changes !== 1) throw new BitbucketInvalid();
      } catch (cause) {
        await erase(userId, [refs.access, refs.refresh]);
        throw cause;
      }
      if (old)
        await erase(userId, [
          old.access_credential_id,
          old.refresh_credential_id,
        ]);
    },
    status: async (userId: string) => {
      let row = await readBitbucketConnection(db, userId);
      if (row?.status === "active") {
        try {
          await withConnection(
            userId,
            row.id,
            async (token, connection) => {
              const user = await provider.getUser(token);
              if (user.id !== connection.provider_account_id) {
                await invalidate(connection);
                throw denied();
              }
            },
            { replayable: true },
          );
        } catch (cause) {
          if (!(cause instanceof SourceControlAccessDenied)) throw cause;
        }
        row = await readBitbucketConnection(db, userId);
      }
      return {
        configured: true,
        connection:
          row === null
            ? null
            : { id: row.id, accountName: row.account_name, status: row.status },
      };
    },
    repositories: (userId: string) =>
      withConnection(
        userId,
        undefined,
        async (token, row) => {
          const repositories = await provider.listRepositories(token);
          // Cached rows are identity hints only. Every operation rechecks live access.
          for (let offset = 0; offset < repositories.length; offset += 100) {
            await db.batch(
              repositories
                .slice(offset, offset + 100)
                .map((repo) => cacheRepositoryStatement(row, repo)),
            );
          }
          return { connectionId: row.id, repositories };
        },
        { replayable: true },
      ),
  };
};

export const bitbucketControlPlaneFor = async (
  db: D1Database,
  bindings: Bindings,
  fetcher?: typeof fetch,
) => {
  const config = await Effect.runPromise(loadBitbucketConfiguration(bindings));
  const keyring = await Effect.runPromise(
    loadConfigEncryptionKeyring(bindings),
  );
  const vault = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* IntegrationCredentialVault;
    }).pipe(Effect.provide(IntegrationCredentialVaultD1(db))),
  );
  return createBitbucketControlPlane({ db, config, keyring, vault, fetcher });
};

export const mapBitbucketSourceError = (cause: unknown) => {
  if (cause instanceof SourceControlAccessDenied) return cause;
  if (
    cause instanceof BitbucketProviderError &&
    ["forbidden", "not-found"].includes(cause.category)
  )
    return sourceAccessDenied("repository-access-removed", "rebind");
  return new SourceControlProviderFailure({
    provider: "bitbucket",
    retryable:
      cause instanceof BitbucketProviderError &&
      ["rate-limited", "unavailable"].includes(cause.category),
  });
};

export const authorizeBitbucketSource = async (input: {
  db: D1Database;
  bindings: Bindings;
  owner: SourceOwner;
  grantId: string;
  repositoryId: string;
  workspaceId?: string;
  readPaths?: ReadonlyArray<string>;
  fetcher?: typeof fetch;
}): Promise<AuthorizedSource> => {
  try {
    if (input.owner.scope !== "personal")
      throw sourceAccessDenied(
        "personal-grant-not-allowed-for-workspace",
        "contact-workspace-admin",
      );
    const service = await bitbucketControlPlaneFor(
      input.db,
      input.bindings,
      input.fetcher,
    );
    return await service.withConnection(
      input.owner.id,
      input.grantId,
      async (token, row, provider) => {
        const cached = await input.db
          .prepare(
            "SELECT workspace_id FROM bitbucket_repository WHERE connection_id = ? AND repository_id = ?",
          )
          .bind(row.id, input.repositoryId)
          .first<{ workspace_id: string }>();
        const workspaceId = input.workspaceId ?? cached?.workspace_id;
        if (!workspaceId)
          throw sourceAccessDenied("repository-not-selected", "rebind");
        const resolved = await provider.resolveRepositorySource(
          token,
          workspaceId,
          input.repositoryId,
        );
        if (
          resolved.repository.id !== input.repositoryId ||
          resolved.repository.workspaceId !== workspaceId ||
          !resolved.commitSha
        )
          throw sourceAccessDenied("stale-binding", "rebind");
        await service.cacheRepository(row, resolved.repository);
        const presentPaths =
          input.readPaths === undefined
            ? undefined
            : await provider.presentPaths(
                token,
                workspaceId,
                input.repositoryId,
                resolved.commitSha,
                input.readPaths,
              );
        return {
          provider: "bitbucket",
          owner: input.owner,
          grantId: row.id,
          providerWorkspaceId: workspaceId,
          providerRepositoryId: resolved.repository.id,
          fullName: resolved.repository.fullName,
          webUrl: resolved.repository.webUrl,
          cloneUrl: resolved.repository.cloneUrl,
          defaultBranch: resolved.repository.defaultBranch,
          visibility: resolved.repository.visibility,
          commitSha: resolved.commitSha,
          authorizationEpoch: row.authorization_epoch,
          installationEpoch: 0,
          policyRevision: 0,
          ...(presentPaths === undefined ? {} : { presentPaths }),
        };
      },
      { replayable: true },
    );
  } catch (cause) {
    throw mapBitbucketSourceError(cause);
  }
};

export const recheckBitbucketThreadSource = async (input: {
  db: D1Database;
  bindings: Bindings;
  threadId: string;
  ownerUserId: string;
}) => {
  const row = await readBitbucketThreadAuthority(
    input.db,
    input.threadId,
    input.ownerUserId,
  );
  const source = await authorizeBitbucketSource({
    ...input,
    owner: { scope: "personal", id: input.ownerUserId },
    grantId: row.grantId,
    repositoryId: row.providerRepositoryId,
    workspaceId: row.providerWorkspaceId,
  });
  if (
    source.authorizationEpoch !== row.authorizationEpoch ||
    source.fullName !== row.repositoryName
  )
    throw sourceAccessDenied("stale-snapshot", "rebind");
};

export const readBitbucketThreadAuthority = async (
  db: D1Database,
  threadId: string,
  actorUserId: string,
) => {
  const row = await db
    .prepare(`SELECT t.project_id, s.repository_full_name, s.default_branch, s.binding_revision,
    a.owner_grant_id, a.provider_repository_id, a.provider_workspace_id, a.authorization_epoch, c.provider_account_id
    FROM threads t JOIN projects p ON p.id = t.project_id JOIN thread_source_snapshot s ON s.thread_id = t.id
    JOIN thread_source_authority a ON a.thread_id = t.id JOIN project_repository r ON r.project_id = p.id
    JOIN project_source_authority b ON b.project_id = p.id JOIN bitbucket_connection c ON c.id = a.owner_grant_id
    WHERE t.id = ? AND t.owner_user_id = ?
      AND (p.workspace_id IS NOT NULL OR p.owner_user_id = ?)
      AND (p.workspace_id IS NULL OR EXISTS (
        SELECT 1 FROM member JOIN organization ON organization.id = member.organizationId
        WHERE member.organizationId = p.workspace_id AND member.userId = t.owner_user_id
          AND organization.lifecycleState = 'active'))
      AND t.lifecycle_state = 'active' AND s.provider = 'bitbucket' AND r.provider = 'bitbucket' AND b.provider = 'bitbucket'
      AND s.binding_revision = r.binding_revision AND b.binding_revision = r.binding_revision
      AND s.repository_full_name = r.full_name
      AND a.provider_repository_id = b.provider_repository_id AND a.provider_workspace_id = b.provider_workspace_id
      AND c.authorization_epoch = a.authorization_epoch
      -- The binding owner uses the bound connection; another workspace member
      -- uses their own connection captured on the Thread.
      AND ((b.owner_id = ? AND a.owner_grant_id = b.owner_grant_id
            AND a.authorization_epoch = b.authorization_epoch)
        OR (b.owner_id != t.owner_user_id AND p.workspace_id IS NOT NULL))
      AND c.user_id = ? AND c.status = 'active' AND b.owner_scope = 'personal'
      AND b.provenance = 'live-grant' AND b.source_health = 'available' AND a.installation_id IS NULL
      AND b.installation_id IS NULL AND a.installation_epoch = 0 AND b.installation_epoch = 0
      AND a.policy_revision = 0 AND b.policy_revision = 0`)
    .bind(threadId, actorUserId, actorUserId, actorUserId, actorUserId)
    .first<{
      project_id: string;
      repository_full_name: string;
      default_branch: string;
      binding_revision: number;
      owner_grant_id: string;
      provider_repository_id: string;
      provider_workspace_id: string;
      authorization_epoch: number;
      provider_account_id: string;
    }>();
  if (!row) throw sourceAccessDenied("stale-snapshot", "rebind");
  return {
    threadId,
    actorUserId,
    projectId: row.project_id,
    repositoryName: row.repository_full_name,
    defaultBranch: row.default_branch,
    bindingRevision: row.binding_revision,
    grantId: row.owner_grant_id,
    providerRepositoryId: row.provider_repository_id,
    providerWorkspaceId: row.provider_workspace_id,
    authorizationEpoch: row.authorization_epoch,
    providerAccountId: row.provider_account_id,
  };
};
