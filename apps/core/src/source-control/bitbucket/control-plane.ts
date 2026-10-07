import {
  type IntegrationOwner,
  integrationCredentialReferenceFor,
  SourceControlAccessDenied,
  SourceControlProviderFailure,
} from "@dx/domain";
import { Effect, Schema } from "effect";
import type { Bindings } from "../../http/types.js";
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
      !row ||
      row.status !== "active" ||
      !row.access_credential_id ||
      !row.refresh_credential_id
    )
      throw denied();
    return row;
  };
  const accessToken = async (
    initial: BitbucketConnectionRow,
  ): Promise<{ row: BitbucketConnectionRow; token: string }> => {
    if (initial.refresh_lock_id !== null) {
      if (
        initial.refresh_lock_until !== null &&
        initial.refresh_lock_until <= now()
      ) {
        // A crashed refresh may have rotated remotely. Never replay the old token.
        await invalidate(initial);
        throw denied();
      }
      throw unavailable();
    }
    if (
      initial.expires_at !== null &&
      Date.parse(initial.expires_at) > Date.now() + 60_000
    )
      return {
        row: initial,
        token: await read(
          initial,
          "access-token",
          initial.access_credential_id as string,
        ),
      };
    const lockId = crypto.randomUUID();
    const lock = await db
      .prepare(
        "UPDATE bitbucket_connection SET refresh_lock_id = ?, refresh_lock_until = ? WHERE id = ? AND status = 'active' AND authorization_epoch = ? AND refresh_lock_id IS NULL AND access_credential_id = ?",
      )
      .bind(
        lockId,
        new Date(Date.now() + 60_000).toISOString(),
        initial.id,
        initial.authorization_epoch,
        initial.access_credential_id,
      )
      .run();
    if (lock.meta.changes !== 1) throw unavailable();
    let refs: { access: string; refresh: string } | undefined;
    let committed = false;
    try {
      const tokens = await provider.refreshToken(
        await read(
          initial,
          "refresh-token",
          initial.refresh_credential_id as string,
        ),
      );
      refs = await store(initial.user_id, tokens);
      const result = await db
        .prepare(
          "UPDATE bitbucket_connection SET access_credential_id = ?, refresh_credential_id = ?, expires_at = ?, refresh_lock_id = NULL, refresh_lock_until = NULL, updated_at = ? WHERE id = ? AND status = 'active' AND authorization_epoch = ? AND refresh_lock_id = ?",
        )
        .bind(
          refs.access,
          refs.refresh,
          tokens.expiresAt.toISOString(),
          now(),
          initial.id,
          initial.authorization_epoch,
          lockId,
        )
        .run();
      if (result.meta.changes !== 1) {
        await erase(initial.user_id, [refs.access, refs.refresh]);
        throw denied();
      }
      committed = true;
      // Reclaim superseded secrets before the fallible post-commit re-read.
      // Cleanup failure must not invalidate the active replacements.
      await erase(initial.user_id, [
        initial.access_credential_id,
        initial.refresh_credential_id,
      ]).catch(() => undefined);
      const activeResult = {
        row: await active(initial.user_id, initial.id),
        token: tokens.accessToken,
      };
      return activeResult;
    } catch (cause) {
      // Pre-commit uncertainty requires fresh consent. A confirmed commit does
      // not become invalid because a later read failed.
      if (committed) {
        if (cause instanceof SourceControlAccessDenied) throw cause;
        throw unavailable();
      }
      await invalidate(initial);
      if (cause instanceof SourceControlAccessDenied) throw cause;
      throw denied();
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
  ): Promise<A> => {
    const { row, token } = await accessToken(
      await active(userId, connectionId),
    );
    try {
      const result = await callback(token, row, provider);
      const after = await active(userId, row.id);
      if (after.authorization_epoch !== row.authorization_epoch) throw denied();
      return result;
    } catch (cause) {
      if (
        cause instanceof BitbucketProviderError &&
        (cause.category === "unauthorized" ||
          cause.category === "invalid-grant")
      ) {
        await invalidate(row);
        throw denied();
      }
      throw cause;
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
          await withConnection(userId, row.id, async (token, connection) => {
            const user = await provider.getUser(token);
            if (user.id !== connection.provider_account_id) {
              await invalidate(connection);
              throw denied();
            }
          });
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
      withConnection(userId, undefined, async (token, row) => {
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
      }),
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
        };
      },
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
    a.owner_grant_id, a.provider_repository_id, a.provider_workspace_id, a.authorization_epoch, p.ship_action, c.provider_account_id
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
      ship_action: "ship" | "commit";
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
    shipAction: row.ship_action,
    providerAccountId: row.provider_account_id,
  };
};
