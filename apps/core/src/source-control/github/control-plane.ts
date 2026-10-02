import {
  type IntegrationOwner,
  integrationCredentialReferenceFor,
} from "@dx/domain";
import { Effect, Redacted, Schema } from "effect";
import type { Bindings } from "../../http/types.js";
import { sourceControlLogger } from "../../logging.js";
import {
  type ConfigEncryptionKeyring,
  loadConfigEncryptionKeyring,
} from "../../settings/environment-variables/encryption.js";
import {
  IntegrationCredentialVault,
  IntegrationCredentialVaultD1,
  type IntegrationCredentialVaultShape,
} from "../../settings/integrations/credential-vault.js";
import {
  createOAuthProof,
  hashOAuthState,
} from "../../settings/integrations/provider-registry.js";
import { createGitHubAppJwt } from "./app-auth.js";
import {
  type GitHubAppConfiguration,
  loadGitHubAppConfiguration,
} from "./configuration.js";
import {
  createGitHubProvider,
  type GitHubInstallation,
  GitHubProviderError,
  type GitHubRepository,
} from "./provider-http.js";

const CEREMONY_TTL_MS = 10 * 60 * 1_000;
const USER_TOKEN_REFRESH_MARGIN_MS = 60 * 60 * 1_000;

export class GitHubControlPlaneInvalid extends Schema.TaggedError<GitHubControlPlaneInvalid>()(
  "GitHubControlPlaneInvalid",
  {},
) {}

export class GitHubControlPlaneForbidden extends Schema.TaggedError<GitHubControlPlaneForbidden>()(
  "GitHubControlPlaneForbidden",
  {},
) {}

export type GitHubOwner = {
  readonly scope: "personal" | "workspace";
  readonly id: string;
};

const personalOwner = (userId: string): IntegrationOwner => ({
  scope: "personal",
  id: userId as never,
});

const nowIso = () => new Date().toISOString();
const expiry = () => new Date(Date.now() + CEREMONY_TTL_MS).toISOString();
const RETURN_TO_ORIGIN = "https://dx.invalid";

const isSettingsPath = (pathname: string) =>
  pathname === "/settings" ||
  pathname.startsWith("/settings/") ||
  pathname === "/workspaces" ||
  pathname.startsWith("/workspaces/");

const validateReturnTo = (returnTo: string | undefined) => {
  if (returnTo === undefined) return undefined;
  if (
    returnTo.length < 1 ||
    returnTo.length > 2_048 ||
    !returnTo.startsWith("/") ||
    returnTo.startsWith("//")
  )
    throw new GitHubControlPlaneInvalid();
  try {
    const url = new URL(returnTo, RETURN_TO_ORIGIN);
    if (url.origin !== RETURN_TO_ORIGIN || isSettingsPath(url.pathname))
      throw new GitHubControlPlaneInvalid();
  } catch (cause) {
    if (cause instanceof GitHubControlPlaneInvalid) throw cause;
    throw new GitHubControlPlaneInvalid();
  }
  return returnTo;
};

const requiredPermissions = (
  config: GitHubAppConfiguration,
  installation: GitHubInstallation,
) => ({
  ...config.repositoryPermissions,
  ...(installation.account.type === "Organization"
    ? { organization_projects: config.organizationPermissions.projects }
    : {}),
});

const permissionsMatch = (
  config: GitHubAppConfiguration,
  installation: GitHubInstallation,
) =>
  Object.entries(requiredPermissions(config, installation)).every(
    ([name, level]) => installation.permissions[name] === level,
  );

const incrementEpoch = (
  db: D1Database,
  kind: "user-authorization" | "installation" | "owner-grant",
  subjectId: string,
  now: string,
) =>
  db
    .prepare(`
      INSERT INTO github_authorization_epoch (subject_kind, subject_id, epoch, updated_at)
      VALUES (?, ?, 2, ?)
      ON CONFLICT(subject_kind, subject_id) DO UPDATE SET
        epoch = epoch + 1, updated_at = excluded.updated_at
    `)
    .bind(kind, subjectId, now);

interface AuthorizationRow {
  readonly id: string;
  readonly access_token_reference_id: string;
  readonly refresh_token_reference_id: string | null;
  readonly provider_account_id: string;
  readonly provider_account_login: string;
  readonly expires_at: string | null;
}

interface OAuthTransactionRow {
  readonly id: string;
  readonly verifier_reference_id: string;
  readonly return_to: string | null;
}

interface SetupTransactionRow {
  readonly id: string;
  readonly actor_user_id: string;
  readonly owner_scope: "personal" | "workspace";
  readonly owner_id: string;
  readonly verifier_reference_id: string;
  readonly return_to: string | null;
}

const activeAuthorization = async (db: D1Database, userId: string) => {
  const row = await db
    .prepare(`
      SELECT id, access_token_reference_id, refresh_token_reference_id,
             provider_account_id, provider_account_login, expires_at
        FROM github_user_authorization
       WHERE user_id = ? AND status = 'active'
         AND access_token_reference_id IS NOT NULL
       ORDER BY updated_at DESC, id DESC LIMIT 1
    `)
    .bind(userId)
    .first<AuthorizationRow>();
  if (row === null) throw new GitHubControlPlaneForbidden();
  return row;
};

const readAccessToken = (
  vault: IntegrationCredentialVaultShape,
  keyring: ConfigEncryptionKeyring,
  userId: string,
  referenceId: string,
) =>
  Effect.runPromise(
    vault.read(
      keyring,
      personalOwner(userId),
      "access-token",
      integrationCredentialReferenceFor(referenceId as never),
    ),
  );

const listRepositoriesWithLease = async (
  provider: ReturnType<typeof createGitHubProvider>,
  appJwt: string,
  installationId: string,
) => {
  const token = await provider.createInstallationToken(appJwt, installationId);
  try {
    return await provider.listInstallationRepositories(token.token);
  } finally {
    await provider.revokeInstallationToken(token.token).catch(() => {
      sourceControlLogger.warn(
        "GitHub reconciliation token revocation failed.",
        {
          event: "github_reconciliation_token_revoke_failed",
        },
      );
    });
  }
};

const reconcileProvider = async (
  config: GitHubAppConfiguration,
  provider: ReturnType<typeof createGitHubProvider>,
  accessToken: string,
  installationId: string,
) => {
  const visible = await provider.listUserInstallations(accessToken);
  const actorInstallation = visible.find((item) => item.id === installationId);
  if (actorInstallation === undefined) throw new GitHubControlPlaneForbidden();
  const appJwt = await createGitHubAppJwt({
    appId: config.appId,
    privateKeyPem: Redacted.value(config.privateKeyPem),
  });
  const installation = await provider.getInstallation(appJwt, installationId);
  if (
    installation.id !== actorInstallation.id ||
    installation.account.id !== actorInstallation.account.id
  )
    throw new GitHubControlPlaneForbidden();
  const repositories = await listRepositoriesWithLease(
    provider,
    appJwt,
    installationId,
  );
  return { installation, repositories };
};

const writeInstallation = async (
  db: D1Database,
  config: GitHubAppConfiguration,
  installation: GitHubInstallation,
  repositories: ReadonlyArray<GitHubRepository>,
  now: string,
  expectedEpoch: number,
) => {
  const previous = await db
    .prepare("SELECT status FROM github_installation WHERE installation_id = ?")
    .bind(installation.id)
    .first<{ status: string }>();
  const previousRepositories = await db
    .prepare(`
      SELECT provider_repository_id FROM github_installation_repository
       WHERE installation_id = ? AND entitled = 1
    `)
    .bind(installation.id)
    .all<{ provider_repository_id: string }>();
  const nextRepositoryIds = new Set(
    repositories.map((repository) => repository.id),
  );
  const removedRepositoryIds = previousRepositories.results
    .map((repository) => repository.provider_repository_id)
    .filter((repositoryId) => !nextRepositoryIds.has(repositoryId));
  const status =
    installation.suspendedAt !== undefined
      ? "suspended"
      : permissionsMatch(config, installation)
        ? "active"
        : "permissions-pending";
  const authorityChanged =
    previous !== null &&
    (previous.status !== status || removedRepositoryIds.length > 0);
  const grants = authorityChanged
    ? await db
        .prepare("SELECT id FROM github_owner_grant WHERE installation_id = ?")
        .bind(installation.id)
        .all<{ id: string }>()
    : { results: [] as Array<{ id: string }> };
  const currentEpoch = `COALESCE((SELECT epoch FROM github_authorization_epoch
    WHERE subject_kind = 'installation' AND subject_id = ?), 1)`;
  const results = await db.batch([
    db
      .prepare(`
        INSERT INTO github_installation (
          installation_id, app_id, provider_account_id, provider_account_type,
          provider_account_login, repository_selection, status,
          permissions_version, suspended_at, last_reconciled_at, created_at, updated_at
        ) SELECT ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?
          WHERE ${currentEpoch} = ?
        ON CONFLICT(installation_id) DO UPDATE SET
          app_id = excluded.app_id,
          provider_account_id = excluded.provider_account_id,
          provider_account_type = excluded.provider_account_type,
          provider_account_login = excluded.provider_account_login,
          repository_selection = excluded.repository_selection,
          status = excluded.status,
          suspended_at = excluded.suspended_at,
          removed_at = NULL,
          last_reconciled_at = excluded.last_reconciled_at,
          updated_at = excluded.updated_at
          WHERE ${currentEpoch} = ?
      `)
      .bind(
        installation.id,
        config.appId,
        installation.account.id,
        installation.account.type.toLowerCase(),
        installation.account.login,
        installation.repositorySelection,
        status,
        installation.suspendedAt?.toISOString() ?? null,
        now,
        now,
        now,
        installation.id,
        expectedEpoch,
        installation.id,
        expectedEpoch,
      ),
    db
      .prepare(
        `UPDATE github_installation_repository
            SET entitled = 0, last_reconciled_at = ?
          WHERE installation_id = ? AND ${currentEpoch} = ?`,
      )
      .bind(now, installation.id, installation.id, expectedEpoch),
    ...repositories.map((repository) =>
      db
        .prepare(`
          INSERT INTO github_installation_repository (
            installation_id, provider_repository_id, full_name, web_url,
            visibility, entitled, last_reconciled_at
          ) SELECT ?, ?, ?, ?, ?, 1, ?
            WHERE ${currentEpoch} = ?
          ON CONFLICT(installation_id, provider_repository_id) DO UPDATE SET
            full_name = excluded.full_name, web_url = excluded.web_url,
            visibility = excluded.visibility, entitled = 1,
            last_reconciled_at = excluded.last_reconciled_at
            WHERE ${currentEpoch} = ?
        `)
        .bind(
          installation.id,
          repository.id,
          repository.fullName,
          repository.webUrl,
          repository.visibility,
          now,
          installation.id,
          expectedEpoch,
          installation.id,
          expectedEpoch,
        ),
    ),
    ...removedRepositoryIds.map((repositoryId) =>
      db
        .prepare(`
          DELETE FROM github_owner_repository_selection
           WHERE installation_id = ? AND provider_repository_id = ?
             AND ${currentEpoch} = ?
        `)
        .bind(installation.id, repositoryId, installation.id, expectedEpoch),
    ),
    ...(authorityChanged
      ? [
          ...grants.results.map((grant) =>
            db
              .prepare(`
                INSERT INTO github_authorization_epoch (
                  subject_kind, subject_id, epoch, updated_at
                ) SELECT 'owner-grant', ?, 2, ? WHERE ${currentEpoch} = ?
                ON CONFLICT(subject_kind, subject_id) DO UPDATE SET
                  epoch = github_authorization_epoch.epoch + 1,
                  updated_at = excluded.updated_at
                WHERE ${currentEpoch} = ?
              `)
              .bind(
                grant.id,
                now,
                installation.id,
                expectedEpoch,
                installation.id,
                expectedEpoch,
              ),
          ),
          db
            .prepare(`
              INSERT INTO github_authorization_epoch (
                subject_kind, subject_id, epoch, updated_at
              ) SELECT 'installation', ?, 2, ? WHERE ${currentEpoch} = ?
              ON CONFLICT(subject_kind, subject_id) DO UPDATE SET
                epoch = github_authorization_epoch.epoch + 1,
                updated_at = excluded.updated_at
              WHERE github_authorization_epoch.epoch = ?
            `)
            .bind(
              installation.id,
              now,
              installation.id,
              expectedEpoch,
              expectedEpoch,
            ),
        ]
      : []),
  ]);
  if (results[0]?.meta.changes !== 1) throw new GitHubControlPlaneInvalid();
  return { status, epoch: expectedEpoch + (authorityChanged ? 1 : 0) };
};

const installationEpoch = async (db: D1Database, installationId: string) => {
  const row = await db
    .prepare(`
      SELECT epoch FROM github_authorization_epoch
       WHERE subject_kind = 'installation' AND subject_id = ?
    `)
    .bind(installationId)
    .first<{ epoch: number }>();
  return row?.epoch ?? 1;
};

export const reconcileGitHubInstallationWithApp = async (input: {
  readonly db: D1Database;
  readonly config: GitHubAppConfiguration;
  readonly installationId: string;
  readonly fetcher?: typeof fetch;
}) => {
  const expectedEpoch = await installationEpoch(input.db, input.installationId);
  const provider = createGitHubProvider(input.config, input.fetcher);
  const appJwt = await createGitHubAppJwt({
    appId: input.config.appId,
    privateKeyPem: Redacted.value(input.config.privateKeyPem),
  });
  const installation = await provider.getInstallation(
    appJwt,
    input.installationId,
  );
  const repositories = await listRepositoriesWithLease(
    provider,
    appJwt,
    input.installationId,
  );
  const result = await writeInstallation(
    input.db,
    input.config,
    installation,
    repositories,
    nowIso(),
    expectedEpoch,
  );
  return result.status;
};

export const createGitHubControlPlane = (input: {
  readonly db: D1Database;
  readonly config: GitHubAppConfiguration;
  readonly keyring: ConfigEncryptionKeyring;
  readonly vault: IntegrationCredentialVaultShape;
  readonly fetcher?: typeof fetch;
}) => {
  const { db, config, keyring, vault } = input;
  const putTokenPair = async (
    owner: IntegrationOwner,
    accessToken: string,
    refreshToken: string,
  ) => {
    const accessReference = await Effect.runPromise(
      vault.put(keyring, owner, "access-token", accessToken),
    );
    try {
      const refreshReference = await Effect.runPromise(
        vault.put(keyring, owner, "refresh-token", refreshToken),
      );
      return { accessReference, refreshReference };
    } catch (cause) {
      await Effect.runPromise(
        Effect.ignore(vault.remove(owner, accessReference)),
      );
      throw cause;
    }
  };
  const provider = createGitHubProvider(config, input.fetcher);

  const removeExpiredTransactions = async () => {
    const now = nowIso();
    const [oauth, setup] = await Promise.all([
      db
        .prepare(`
          SELECT id, actor_user_id, verifier_reference_id
            FROM github_oauth_transaction WHERE expires_at <= ?
        `)
        .bind(now)
        .all<{
          id: string;
          actor_user_id: string;
          verifier_reference_id: string;
        }>(),
      db
        .prepare(`
          SELECT id, actor_user_id, verifier_reference_id
            FROM github_setup_transaction WHERE expires_at <= ?
        `)
        .bind(now)
        .all<{
          id: string;
          actor_user_id: string;
          verifier_reference_id: string;
        }>(),
    ]);
    const expired = [...oauth.results, ...setup.results];
    if (expired.length === 0) return;
    await db.batch([
      ...oauth.results.map((transaction) =>
        db
          .prepare("DELETE FROM github_oauth_transaction WHERE id = ?")
          .bind(transaction.id),
      ),
      ...setup.results.map((transaction) =>
        db
          .prepare("DELETE FROM github_setup_transaction WHERE id = ?")
          .bind(transaction.id),
      ),
    ]);
    await Promise.all(
      expired.map((transaction) =>
        Effect.runPromise(
          Effect.ignore(
            vault.remove(
              personalOwner(transaction.actor_user_id),
              integrationCredentialReferenceFor(
                transaction.verifier_reference_id as never,
              ),
            ),
          ),
        ),
      ),
    );
  };

  const removeOrphanedInstallations = async (userId: string) => {
    const installations = await db
      .prepare(`
        SELECT DISTINCT stale.installation_id
          FROM github_owner_grant AS stale
         WHERE stale.owner_scope = 'personal' AND stale.owner_id = ?
           AND stale.status = 'disconnected'
           AND NOT EXISTS (
             SELECT 1 FROM github_owner_grant AS current
              WHERE current.installation_id = stale.installation_id
                AND current.status != 'disconnected'
           )
      `)
      .bind(userId)
      .all<{ installation_id: string }>();
    if (installations.results.length === 0) return;
    const appJwt = await createGitHubAppJwt({
      appId: config.appId,
      privateKeyPem: Redacted.value(config.privateKeyPem),
    });
    for (const installation of installations.results) {
      await provider.deleteInstallation(appJwt, installation.installation_id);
      const now = nowIso();
      const grants = await db
        .prepare("SELECT id FROM github_owner_grant WHERE installation_id = ?")
        .bind(installation.installation_id)
        .all<{ id: string }>();
      await db.batch([
        db
          .prepare(`
            UPDATE github_installation
               SET status = 'removed', removed_at = ?, updated_at = ?
             WHERE installation_id = ?
          `)
          .bind(now, now, installation.installation_id),
        db
          .prepare(`
            UPDATE github_installation_repository
               SET entitled = 0, last_reconciled_at = ?
             WHERE installation_id = ?
          `)
          .bind(now, installation.installation_id),
        db
          .prepare(
            "DELETE FROM github_owner_repository_selection WHERE installation_id = ?",
          )
          .bind(installation.installation_id),
        incrementEpoch(db, "installation", installation.installation_id, now),
        ...grants.results.map((grant) =>
          incrementEpoch(db, "owner-grant", grant.id, now),
        ),
      ]);
    }
  };

  const beginAuthorization = async (
    userId: string,
    browserSessionId: string,
    returnTo?: string,
  ) => {
    const validatedReturnTo = validateReturnTo(returnTo);
    await removeExpiredTransactions();
    await removeOrphanedInstallations(userId);
    const proof = await createOAuthProof();
    const stateHash = await hashOAuthState(proof.state);
    const owner = personalOwner(userId);
    const verifier = await Effect.runPromise(
      vault.put(keyring, owner, "pkce-verifier", proof.codeVerifier),
    );
    const expiresAt = expiry();
    try {
      await db
        .prepare(`
          INSERT INTO github_oauth_transaction (
            id, state_hash, actor_user_id, browser_session_id,
            verifier_reference_id, return_to, expires_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .bind(
          `gho_${crypto.randomUUID()}`,
          stateHash,
          userId,
          browserSessionId,
          verifier.id,
          validatedReturnTo ?? null,
          expiresAt,
          nowIso(),
        )
        .run();
    } catch (cause) {
      await Effect.runPromise(Effect.ignore(vault.remove(owner, verifier)));
      throw cause;
    }
    return {
      authorizationUrl: provider.authorizationUrl(
        proof.state,
        proof.codeChallenge,
      ),
      expiresAt,
    };
  };

  const completeAuthorization = async (
    userId: string,
    browserSessionId: string,
    state: string,
    code: string,
  ) => {
    const stateHash = await hashOAuthState(state);
    const now = nowIso();
    const claim = await db
      .prepare(`
        UPDATE github_oauth_transaction SET consumed_at = ?
         WHERE state_hash = ? AND actor_user_id = ? AND browser_session_id = ?
           AND consumed_at IS NULL AND expires_at > ?
      `)
      .bind(now, stateHash, userId, browserSessionId, now)
      .run();
    if (claim.meta.changes !== 1) throw new GitHubControlPlaneInvalid();
    const transaction = await db
      .prepare(
        "SELECT id, verifier_reference_id, return_to FROM github_oauth_transaction WHERE state_hash = ?",
      )
      .bind(stateHash)
      .first<OAuthTransactionRow>();
    if (transaction === null) throw new GitHubControlPlaneInvalid();
    const owner = personalOwner(userId);
    const verifierReference = integrationCredentialReferenceFor(
      transaction.verifier_reference_id as never,
    );
    const verifier = await Effect.runPromise(
      vault.read(keyring, owner, "pkce-verifier", verifierReference),
    );
    await db
      .prepare("DELETE FROM github_oauth_transaction WHERE id = ?")
      .bind(transaction.id)
      .run();
    await Effect.runPromise(
      Effect.ignore(vault.remove(owner, verifierReference)),
    );
    const tokens = await provider.exchangeCode(code, verifier);
    const user = await provider.getUser(tokens.accessToken);
    const { accessReference, refreshReference } = await putTokenPair(
      owner,
      tokens.accessToken,
      tokens.refreshToken,
    );
    const id = `ghu_${userId}_${user.id}`;
    const previous = await db
      .prepare(`
        SELECT access_token_reference_id, refresh_token_reference_id
          FROM github_user_authorization
         WHERE user_id = ? AND provider_account_id = ?
      `)
      .bind(userId, user.id)
      .first<{
        access_token_reference_id: string | null;
        refresh_token_reference_id: string | null;
      }>();
    const otherAuthorizations = await db
      .prepare(`
        SELECT id, access_token_reference_id, refresh_token_reference_id
          FROM github_user_authorization
         WHERE user_id = ? AND provider_account_id != ? AND status = 'active'
      `)
      .bind(userId, user.id)
      .all<{
        id: string;
        access_token_reference_id: string | null;
        refresh_token_reference_id: string | null;
      }>();
    const replacedPersonalGrants =
      otherAuthorizations.results.length === 0
        ? { results: [] as Array<{ id: string }> }
        : await db
            .prepare(`
              SELECT id FROM github_owner_grant
               WHERE owner_scope = 'personal' AND owner_id = ?
                 AND status != 'disconnected'
            `)
            .bind(userId)
            .all<{ id: string }>();
    try {
      await db.batch([
        db
          .prepare(`
          INSERT INTO github_user_authorization (
            id, user_id, provider_account_id, provider_account_login, status,
            access_token_reference_id, refresh_token_reference_id, expires_at,
            refresh_expires_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_id, provider_account_id) DO UPDATE SET
            provider_account_login = excluded.provider_account_login,
            status = 'active',
            access_token_reference_id = excluded.access_token_reference_id,
            refresh_token_reference_id = excluded.refresh_token_reference_id,
            expires_at = excluded.expires_at,
            refresh_expires_at = excluded.refresh_expires_at,
            updated_at = excluded.updated_at
        `)
          .bind(
            id,
            userId,
            user.id,
            user.login,
            accessReference.id,
            refreshReference.id,
            tokens.expiresAt.toISOString(),
            tokens.refreshExpiresAt?.toISOString() ?? null,
            now,
            now,
          ),
        db
          .prepare(`
          UPDATE github_user_authorization
             SET status = 'revoked', access_token_reference_id = NULL,
                 refresh_token_reference_id = NULL, updated_at = ?
           WHERE user_id = ? AND provider_account_id != ? AND status = 'active'
        `)
          .bind(now, userId, user.id),
        ...otherAuthorizations.results.map((authorization) =>
          incrementEpoch(db, "user-authorization", authorization.id, now),
        ),
        ...(otherAuthorizations.results.length === 0
          ? []
          : [
              db
                .prepare(`
                  UPDATE github_owner_grant
                     SET status = 'disconnected', updated_at = ?
                   WHERE owner_scope = 'personal' AND owner_id = ?
                     AND status != 'disconnected'
                `)
                .bind(now, userId),
              ...replacedPersonalGrants.results.map((grant) =>
                incrementEpoch(db, "owner-grant", grant.id, now),
              ),
            ]),
      ]);
      const staleReferences = [
        previous?.access_token_reference_id,
        previous?.refresh_token_reference_id,
        ...otherAuthorizations.results.flatMap((authorization) => [
          authorization.access_token_reference_id,
          authorization.refresh_token_reference_id,
        ]),
      ].filter(
        (reference): reference is string =>
          reference !== null && reference !== undefined,
      );
      await Promise.all(
        staleReferences.map((reference) =>
          Effect.runPromise(
            Effect.ignore(
              vault.remove(
                owner,
                integrationCredentialReferenceFor(reference as never),
              ),
            ),
          ),
        ),
      );
    } catch (cause) {
      await Promise.all([
        Effect.runPromise(Effect.ignore(vault.remove(owner, accessReference))),
        Effect.runPromise(Effect.ignore(vault.remove(owner, refreshReference))),
      ]);
      throw cause;
    }
    return transaction.return_to ?? undefined;
  };

  const freshAuthorization = async (actorUserId: string) => {
    const authorization = await activeAuthorization(db, actorUserId);
    if (
      authorization.expires_at !== null &&
      Date.parse(authorization.expires_at) > Date.now() + 30_000
    )
      return authorization;
    await refresh(actorUserId);
    return activeAuthorization(db, actorUserId);
  };

  const beginInstallation = async (
    actorUserId: string,
    browserSessionId: string,
    owner: GitHubOwner,
    returnTo?: string,
  ) => {
    const validatedReturnTo = validateReturnTo(returnTo);
    await removeExpiredTransactions();
    try {
      await freshAuthorization(actorUserId);
    } catch (cause) {
      if (
        !(cause instanceof GitHubControlPlaneForbidden) &&
        !(
          cause instanceof GitHubProviderError &&
          (cause.category === "unauthorized" ||
            cause.category === "invalid-response")
        )
      )
        throw cause;
      const authorization = await beginAuthorization(
        actorUserId,
        browserSessionId,
        validatedReturnTo,
      );
      return {
        installationUrl: authorization.authorizationUrl,
        expiresAt: authorization.expiresAt,
      };
    }
    const proof = await createOAuthProof();
    const stateHash = await hashOAuthState(proof.state);
    const verifier = await Effect.runPromise(
      vault.put(
        keyring,
        personalOwner(actorUserId),
        "pkce-verifier",
        proof.codeVerifier,
      ),
    );
    const expiresAt = expiry();
    try {
      await db
        .prepare(`
          INSERT INTO github_setup_transaction (
            id, state_hash, actor_user_id, browser_session_id, owner_scope,
            owner_id, status, verifier_reference_id, return_to, expires_at,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
        `)
        .bind(
          `ghs_${crypto.randomUUID()}`,
          stateHash,
          actorUserId,
          browserSessionId,
          owner.scope,
          owner.id,
          verifier.id,
          validatedReturnTo ?? null,
          expiresAt,
          nowIso(),
        )
        .run();
    } catch (cause) {
      await Effect.runPromise(
        Effect.ignore(vault.remove(personalOwner(actorUserId), verifier)),
      );
      throw cause;
    }
    const query = new URLSearchParams({ state: proof.state });
    return {
      installationUrl: `https://github.com/apps/${config.appSlug}/installations/select_target?${query}`,
      expiresAt,
    };
  };

  const completeInstallation = async (
    actorUserId: string,
    browserSessionId: string,
    state: string,
    installationId: string,
  ) => {
    if (!/^[1-9][0-9]{0,30}$/.test(installationId))
      throw new GitHubControlPlaneInvalid();
    const stateHash = await hashOAuthState(state);
    const now = nowIso();
    const claim = await db
      .prepare(`
        UPDATE github_setup_transaction SET status = 'oauth-proved'
         WHERE state_hash = ? AND actor_user_id = ? AND browser_session_id = ?
           AND status = 'pending' AND consumed_at IS NULL AND expires_at > ?
      `)
      .bind(stateHash, actorUserId, browserSessionId, now)
      .run();
    if (claim.meta.changes !== 1) throw new GitHubControlPlaneInvalid();
    const transaction = await db
      .prepare(`
        SELECT id, actor_user_id, owner_scope, owner_id, verifier_reference_id,
               return_to
          FROM github_setup_transaction WHERE state_hash = ?
      `)
      .bind(stateHash)
      .first<SetupTransactionRow>();
    if (transaction === null) throw new GitHubControlPlaneInvalid();
    const authorization = await freshAuthorization(actorUserId);
    const accessToken = await readAccessToken(
      vault,
      keyring,
      actorUserId,
      authorization.access_token_reference_id,
    );
    const expectedEpoch = await installationEpoch(db, installationId);
    try {
      const reconciled = await reconcileProvider(
        config,
        provider,
        accessToken,
        installationId,
      );
      const { status, epoch } = await writeInstallation(
        db,
        config,
        reconciled.installation,
        reconciled.repositories,
        now,
        expectedEpoch,
      );
      const grantId = `ghg_${transaction.owner_scope}_${transaction.owner_id}_${installationId}`;
      const completed = await db.batch([
        db
          .prepare(`
          UPDATE github_setup_transaction SET status = 'completed', consumed_at = ?
           WHERE id = ? AND status = 'oauth-proved' AND expires_at > ?
             AND EXISTS (SELECT 1 FROM github_user_authorization
               WHERE id = ? AND status = 'active' AND access_token_reference_id = ?)
             AND COALESCE((SELECT epoch FROM github_authorization_epoch
               WHERE subject_kind = 'installation' AND subject_id = ?), 1) = ?
        `)
          .bind(
            nowIso(),
            transaction.id,
            nowIso(),
            authorization.id,
            authorization.access_token_reference_id,
            installationId,
            epoch,
          ),
        db
          .prepare(`
            INSERT INTO github_owner_grant (
              id, owner_scope, owner_id, installation_id, status,
              created_by_user_id, created_at, updated_at
            ) SELECT ?, ?, ?, ?, 'active', ?, ?, ?
              WHERE EXISTS (SELECT 1 FROM github_setup_transaction WHERE id = ? AND status = 'completed')
            ON CONFLICT(owner_scope, owner_id, installation_id) DO UPDATE SET
              status = 'active', updated_at = excluded.updated_at
          `)
          .bind(
            grantId,
            transaction.owner_scope,
            transaction.owner_id,
            installationId,
            actorUserId,
            now,
            now,
            transaction.id,
          ),
        db
          .prepare(
            "DELETE FROM github_setup_transaction WHERE id = ? AND status = 'completed'",
          )
          .bind(transaction.id),
      ]);
      if (completed[0]?.meta.changes !== 1)
        throw new GitHubControlPlaneInvalid();
      const verifierReference = integrationCredentialReferenceFor(
        transaction.verifier_reference_id as never,
      );
      await Effect.runPromise(
        Effect.ignore(
          vault.remove(personalOwner(actorUserId), verifierReference),
        ),
      );
      return {
        grantId,
        status,
        returnTo: transaction.return_to ?? undefined,
      };
    } catch (cause) {
      await db
        .prepare("DELETE FROM github_setup_transaction WHERE id = ?")
        .bind(transaction.id)
        .run();
      await Effect.runPromise(
        Effect.ignore(
          vault.remove(
            personalOwner(actorUserId),
            integrationCredentialReferenceFor(
              transaction.verifier_reference_id as never,
            ),
          ),
        ),
      );
      throw cause;
    }
  };

  const reconcile = (
    actorUserId: string,
    grantId: string,
    owner: GitHubOwner,
  ) =>
    Effect.gen(function* () {
      const grant = yield* Effect.tryPromise({
        try: () =>
          db
            .prepare(`
              SELECT installation_id FROM github_owner_grant
               WHERE id = ? AND owner_scope = ? AND owner_id = ? AND status != 'disconnected'
            `)
            .bind(grantId, owner.scope, owner.id)
            .first<{ installation_id: string }>(),
        catch: (cause) => cause,
      });
      if (grant === null) return yield* new GitHubControlPlaneForbidden();
      const authorization = yield* Effect.tryPromise({
        try: () => freshAuthorization(actorUserId),
        catch: (cause) => cause,
      });
      const accessToken = yield* Effect.tryPromise({
        try: () =>
          readAccessToken(
            vault,
            keyring,
            actorUserId,
            authorization.access_token_reference_id,
          ),
        catch: (cause) => cause,
      });
      const expectedEpoch = yield* Effect.tryPromise({
        try: () => installationEpoch(db, grant.installation_id),
        catch: (cause) => cause,
      });
      const result = yield* Effect.tryPromise({
        try: () =>
          reconcileProvider(
            config,
            provider,
            accessToken,
            grant.installation_id,
          ),
        catch: (cause) => cause,
      });
      const now = nowIso();
      const { status, epoch } = yield* Effect.tryPromise({
        try: () =>
          writeInstallation(
            db,
            config,
            result.installation,
            result.repositories,
            now,
            expectedEpoch,
          ),
        catch: (cause) => cause,
      });
      if (status !== "active") return;
      const reactivated = yield* Effect.tryPromise({
        try: () =>
          db
            .prepare(`
              UPDATE github_owner_grant SET status = 'active', updated_at = ?
               WHERE id = ? AND owner_scope = ? AND owner_id = ?
                 AND status != 'disconnected'
                 AND EXISTS (SELECT 1 FROM github_user_authorization
                   WHERE id = ? AND status = 'active' AND access_token_reference_id = ?)
                 AND COALESCE((SELECT epoch FROM github_authorization_epoch
                   WHERE subject_kind = 'installation' AND subject_id = ?), 1) = ?
            `)
            .bind(
              now,
              grantId,
              owner.scope,
              owner.id,
              authorization.id,
              authorization.access_token_reference_id,
              grant.installation_id,
              epoch,
            )
            .run(),
        catch: (cause) => cause,
      });
      if (reactivated.meta.changes !== 1)
        return yield* new GitHubControlPlaneInvalid();
    });

  const refresh = async (actorUserId: string) => {
    const authorization = await activeAuthorization(db, actorUserId);
    if (authorization.refresh_token_reference_id === null)
      throw new GitHubControlPlaneForbidden();
    const owner = personalOwner(actorUserId);
    const refreshReference = integrationCredentialReferenceFor(
      authorization.refresh_token_reference_id as never,
    );
    const refreshToken = await Effect.runPromise(
      vault.read(keyring, owner, "refresh-token", refreshReference),
    );
    const tokens = await provider.refresh(refreshToken);
    const { accessReference, refreshReference: nextRefreshReference } =
      await putTokenPair(owner, tokens.accessToken, tokens.refreshToken);
    const now = nowIso();
    const update = await db
      .prepare(`
        UPDATE github_user_authorization
           SET access_token_reference_id = ?, refresh_token_reference_id = ?,
               expires_at = ?, refresh_expires_at = ?, updated_at = ?
         WHERE id = ? AND access_token_reference_id = ? AND refresh_token_reference_id = ?
      `)
      .bind(
        accessReference.id,
        nextRefreshReference.id,
        tokens.expiresAt.toISOString(),
        tokens.refreshExpiresAt?.toISOString() ?? null,
        now,
        authorization.id,
        authorization.access_token_reference_id,
        authorization.refresh_token_reference_id,
      )
      .run();
    if (update.meta.changes !== 1) {
      await Promise.all([
        Effect.runPromise(Effect.ignore(vault.remove(owner, accessReference))),
        Effect.runPromise(
          Effect.ignore(vault.remove(owner, nextRefreshReference)),
        ),
      ]);
      throw new GitHubControlPlaneInvalid();
    }
    await Promise.all([
      Effect.runPromise(
        Effect.ignore(
          vault.remove(
            owner,
            integrationCredentialReferenceFor(
              authorization.access_token_reference_id as never,
            ),
          ),
        ),
      ),
      Effect.runPromise(Effect.ignore(vault.remove(owner, refreshReference))),
    ]);
  };

  /**
   * The user's current GitHub App user access token for native Git and `gh`.
   * GitHub disables the previous token when a refresh token is used, so
   * refresh early. A concurrent refresh may rotate the pair and remove the
   * reference this request read; follow the current reference instead.
   */
  const userAccessToken = async (actorUserId: string) => {
    const unexpired = (authorization: AuthorizationRow, marginMs: number) =>
      authorization.expires_at === null ||
      Date.parse(authorization.expires_at) > Date.now() + marginMs;
    let authorization = await activeAuthorization(db, actorUserId);
    if (!unexpired(authorization, USER_TOKEN_REFRESH_MARGIN_MS)) {
      try {
        await refresh(actorUserId);
      } catch (cause) {
        const current = await activeAuthorization(db, actorUserId);
        // Unless another request rotated the pair, keep serving the current
        // token until it actually expires, for example during an outage.
        if (
          current.access_token_reference_id ===
            authorization.access_token_reference_id &&
          !unexpired(current, 30_000)
        )
          throw cause;
      }
      authorization = await activeAuthorization(db, actorUserId);
    }
    const read = (row: AuthorizationRow) =>
      readAccessToken(
        vault,
        keyring,
        actorUserId,
        row.access_token_reference_id,
      );
    try {
      return await read(authorization);
    } catch (cause) {
      const current = await activeAuthorization(db, actorUserId);
      if (
        current.access_token_reference_id ===
        authorization.access_token_reference_id
      )
        throw cause;
      return read(current);
    }
  };

  const revokeAuthorization = async (actorUserId: string) => {
    const authorization = await activeAuthorization(db, actorUserId);
    const owner = personalOwner(actorUserId);
    const accessToken = await readAccessToken(
      vault,
      keyring,
      actorUserId,
      authorization.access_token_reference_id,
    );
    const now = nowIso();
    const personalGrants = await db
      .prepare(`
        SELECT id FROM github_owner_grant
         WHERE owner_scope = 'personal' AND owner_id = ? AND status = 'active'
      `)
      .bind(actorUserId)
      .all<{ id: string }>();
    const revoked = await db.batch([
      db
        .prepare(`
          UPDATE github_user_authorization
             SET status = 'revoked', access_token_reference_id = NULL,
                 refresh_token_reference_id = NULL, updated_at = ?
           WHERE id = ? AND status = 'active'
        `)
        .bind(now, authorization.id),
      incrementEpoch(db, "user-authorization", authorization.id, now),
      db
        .prepare(`
          UPDATE github_owner_grant
             SET status = 'reauthorization-required', updated_at = ?
           WHERE owner_scope = 'personal' AND owner_id = ? AND status = 'active'
        `)
        .bind(now, actorUserId),
      ...personalGrants.results.map((grant) =>
        incrementEpoch(db, "owner-grant", grant.id, now),
      ),
    ]);
    if (revoked[0]?.meta.changes !== 1) throw new GitHubControlPlaneInvalid();
    const references = [
      authorization.access_token_reference_id,
      authorization.refresh_token_reference_id,
    ].filter((reference): reference is string => reference !== null);
    try {
      await provider.revoke(accessToken);
    } finally {
      await Promise.all(
        references.map((reference) =>
          Effect.runPromise(
            Effect.ignore(
              vault.remove(
                owner,
                integrationCredentialReferenceFor(reference as never),
              ),
            ),
          ),
        ),
      );
    }
  };

  const disconnect = async (
    actorUserId: string,
    grantId: string,
    owner: GitHubOwner,
  ) => {
    const grant = await db
      .prepare(`
        SELECT installation_id FROM github_owner_grant
         WHERE id = ? AND owner_scope = ? AND owner_id = ?
           AND status != 'disconnected'
      `)
      .bind(grantId, owner.scope, owner.id)
      .first<{ installation_id: string }>();
    if (grant === null) throw new GitHubControlPlaneForbidden();
    const authorization = await activeAuthorization(db, actorUserId);
    const accessToken = await readAccessToken(
      vault,
      keyring,
      actorUserId,
      authorization.access_token_reference_id,
    );
    const appJwt = await createGitHubAppJwt({
      appId: config.appId,
      privateKeyPem: Redacted.value(config.privateKeyPem),
    });

    await provider.deleteInstallation(appJwt, grant.installation_id);

    const now = nowIso();
    const installationGrants = await db
      .prepare("SELECT id FROM github_owner_grant WHERE installation_id = ?")
      .bind(grant.installation_id)
      .all<{ id: string }>();
    const result = await db.batch([
      db
        .prepare(`
          UPDATE github_installation
             SET status = 'removed', removed_at = ?, updated_at = ?
           WHERE installation_id = ?
        `)
        .bind(now, now, grant.installation_id),
      db
        .prepare(`
          UPDATE github_owner_grant
             SET status = 'disconnected', updated_at = ?
           WHERE installation_id = ? AND status != 'disconnected'
        `)
        .bind(now, grant.installation_id),
      db
        .prepare(`
          UPDATE github_installation_repository
             SET entitled = 0, last_reconciled_at = ?
           WHERE installation_id = ?
        `)
        .bind(now, grant.installation_id),
      db
        .prepare(
          "DELETE FROM github_owner_repository_selection WHERE installation_id = ?",
        )
        .bind(grant.installation_id),
      db
        .prepare(`
          UPDATE github_user_authorization
             SET status = 'revoked', access_token_reference_id = NULL,
                 refresh_token_reference_id = NULL, updated_at = ?
           WHERE id = ? AND status = 'active'
             AND NOT EXISTS (
               SELECT 1 FROM github_owner_grant
                WHERE owner_scope = 'personal' AND owner_id = ?
                  AND status != 'disconnected'
             )
        `)
        .bind(now, authorization.id, actorUserId),
      db
        .prepare(`
        INSERT INTO github_authorization_epoch (subject_kind, subject_id, epoch, updated_at)
        SELECT 'user-authorization', ?, 2, ? WHERE changes() = 1
        ON CONFLICT(subject_kind, subject_id) DO UPDATE SET
          epoch = epoch + 1, updated_at = excluded.updated_at
      `)
        .bind(authorization.id, now),
      incrementEpoch(db, "installation", grant.installation_id, now),
      ...installationGrants.results.map((row) =>
        incrementEpoch(db, "owner-grant", row.id, now),
      ),
    ]);
    // Other installations still use this user's renewable authorization.
    if (result[4]?.meta.changes !== 1) return;

    try {
      await provider.revoke(accessToken);
    } catch (cause) {
      sourceControlLogger.warn(
        "GitHub OAuth token revocation failed after App uninstall.",
        {
          event: "github_disconnect_oauth_revoke_failed",
          failureCategory:
            cause instanceof GitHubProviderError
              ? `provider:${cause.category}`
              : "unknown",
        },
      );
    } finally {
      const references = [
        authorization.access_token_reference_id,
        authorization.refresh_token_reference_id,
      ].filter((reference): reference is string => reference !== null);
      await Promise.all(
        references.map((reference) =>
          Effect.runPromise(
            Effect.ignore(
              vault.remove(
                personalOwner(actorUserId),
                integrationCredentialReferenceFor(reference as never),
              ),
            ),
          ),
        ),
      );
    }
  };

  return {
    beginAuthorization,
    completeAuthorization,
    beginInstallation,
    completeInstallation,
    reconcile,
    refresh,
    userAccessToken,
    revokeAuthorization,
    disconnect,
    provider,
  };
};

/** The user's current GitHub user access token; see `userAccessToken`. */
export const readGitHubUserAccessToken = async (
  bindings: Bindings,
  db: D1Database,
  userId: string,
) => {
  const config = await Effect.runPromise(loadGitHubAppConfiguration(bindings));
  const keyring = await Effect.runPromise(
    loadConfigEncryptionKeyring(bindings),
  );
  const vault = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* IntegrationCredentialVault;
    }).pipe(Effect.provide(IntegrationCredentialVaultD1(db))),
  );
  return createGitHubControlPlane({
    db,
    config,
    keyring,
    vault,
  }).userAccessToken(userId);
};

export const listGitHubGrants = async (db: D1Database, owner: GitHubOwner) => {
  const grants = await db
    .prepare(`
      SELECT grant_row.id, grant_row.owner_scope, grant_row.owner_id,
             grant_row.installation_id, grant_row.status,
             installation.status AS installation_status,
             installation.provider_account_id, installation.provider_account_login,
             installation.provider_account_type, installation.repository_selection
        FROM github_owner_grant AS grant_row
        JOIN github_installation AS installation
          ON installation.installation_id = grant_row.installation_id
       WHERE grant_row.owner_scope = ? AND grant_row.owner_id = ?
         AND grant_row.status != 'disconnected'
       ORDER BY grant_row.id
    `)
    .bind(owner.scope, owner.id)
    .all<Record<string, string>>();
  return Promise.all(
    grants.results.map(async (grant) => {
      const repositories = await db
        .prepare(`
          SELECT repository.provider_repository_id, repository.full_name,
                 repository.web_url, repository.visibility
            FROM github_installation_repository AS repository
           WHERE repository.installation_id = ? AND repository.entitled = 1
           ORDER BY repository.provider_repository_id
        `)
        .bind(grant.installation_id)
        .all<Record<string, string | number>>();
      return {
        id: grant.id,
        ownerScope: grant.owner_scope,
        ownerId: grant.owner_id,
        installationId: grant.installation_id,
        status: grant.status,
        installationStatus: grant.installation_status,
        account: {
          id: grant.provider_account_id,
          login: grant.provider_account_login,
          type: grant.provider_account_type,
        },
        repositorySelection: grant.repository_selection,
        repositories: repositories.results.map((repository) => ({
          id: String(repository.provider_repository_id),
          fullName: String(repository.full_name),
          webUrl: String(repository.web_url),
          visibility: repository.visibility,
        })),
      };
    }),
  );
};

export const ownerForGitHubSetupState = async (
  db: D1Database,
  state: string,
  actorUserId: string,
  browserSessionId: string,
) => {
  const stateHash = await hashOAuthState(state);
  const row = await db
    .prepare(`
      SELECT owner_scope, owner_id FROM github_setup_transaction
       WHERE state_hash = ? AND actor_user_id = ? AND browser_session_id = ?
         AND status = 'pending' AND consumed_at IS NULL AND expires_at > ?
    `)
    .bind(stateHash, actorUserId, browserSessionId, nowIso())
    .first<{ owner_scope: "personal" | "workspace"; owner_id: string }>();
  if (row === null) throw new GitHubControlPlaneInvalid();
  return { scope: row.owner_scope, id: row.owner_id } satisfies GitHubOwner;
};
