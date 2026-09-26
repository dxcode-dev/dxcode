import { PersistenceUnavailable } from "@dx/domain";
import { Context, Effect, Layer } from "effect";

const unavailable = (operation: string) => (cause: unknown) =>
  PersistenceUnavailable.new({ operation }, cause);

export interface GitHubUserAuthorizationWrite {
  readonly id: string;
  readonly userId: string;
  readonly providerAccountId: string;
  readonly providerAccountLogin: string;
  readonly status: "active" | "reauthorization-required" | "revoked";
  readonly accessTokenReferenceId?: string;
  readonly refreshTokenReferenceId?: string;
  readonly expiresAt?: string;
  readonly refreshExpiresAt?: string;
  readonly now: string;
}

export interface GitHubInstallationWrite {
  readonly installationId: string;
  readonly appId: string;
  readonly providerAccountId: string;
  readonly providerAccountType: "user" | "organization";
  readonly providerAccountLogin: string;
  readonly repositorySelection: "all" | "selected";
  readonly status: "active" | "suspended" | "removed" | "permissions-pending";
  readonly permissionsVersion: number;
  readonly now: string;
}

export interface GitHubRepositoryShape {
  readonly saveUserAuthorization: (
    input: GitHubUserAuthorizationWrite,
  ) => Effect.Effect<void, unknown>;
  readonly saveInstallation: (
    input: GitHubInstallationWrite,
  ) => Effect.Effect<void, unknown>;
  readonly bindOwner: (input: {
    readonly id: string;
    readonly ownerScope: "personal" | "workspace";
    readonly ownerId: string;
    readonly installationId: string;
    readonly createdByUserId: string;
    readonly now: string;
  }) => Effect.Effect<void, unknown>;
  readonly replaceEntitlements: (
    installationId: string,
    repositories: ReadonlyArray<{
      readonly providerRepositoryId: string;
      readonly fullName: string;
      readonly webUrl: string;
      readonly visibility: "public" | "private" | "internal";
    }>,
    now: string,
  ) => Effect.Effect<void, unknown>;
  readonly insertSetupTransaction: (input: {
    readonly id: string;
    readonly stateHash: string;
    readonly actorUserId: string;
    readonly browserSessionId: string;
    readonly ownerScope: "personal" | "workspace";
    readonly ownerId: string;
    readonly verifierReferenceId: string;
    readonly expiresAt: string;
    readonly now: string;
  }) => Effect.Effect<void, unknown>;
  readonly claimWebhookDelivery: (input: {
    readonly deliveryId: string;
    readonly event:
      | "installation"
      | "installation_repositories"
      | "installation_target"
      | "github_app_authorization"
      | "repository";
    readonly action: string;
    readonly payloadSha256: string;
    readonly installationId?: string;
    readonly expiresAt: string;
    readonly now: string;
  }) => Effect.Effect<boolean, unknown>;
  readonly incrementAuthorizationEpoch: (
    subjectKind: "user-authorization" | "installation" | "owner-grant",
    subjectId: string,
    now: string,
  ) => Effect.Effect<number, unknown>;
}

export class GitHubRepository extends Context.Service<
  GitHubRepository,
  GitHubRepositoryShape
>()("@dx/core/source-control/github/GitHubRepository") {}

export const GitHubRepositoryD1 = (db: D1Database) =>
  Layer.succeed(
    GitHubRepository,
    GitHubRepository.of({
      saveUserAuthorization: (input) =>
        Effect.tryPromise({
          try: () =>
            db
              .prepare(`
              INSERT INTO github_user_authorization (
                id, user_id, provider_account_id, provider_account_login, status,
                access_token_reference_id, refresh_token_reference_id, expires_at,
                refresh_expires_at, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(user_id, provider_account_id) DO UPDATE SET
                provider_account_login = excluded.provider_account_login,
                status = excluded.status,
                access_token_reference_id = excluded.access_token_reference_id,
                refresh_token_reference_id = excluded.refresh_token_reference_id,
                expires_at = excluded.expires_at,
                refresh_expires_at = excluded.refresh_expires_at,
                updated_at = excluded.updated_at
              ON CONFLICT(id) DO UPDATE SET
                provider_account_login = excluded.provider_account_login,
                status = excluded.status,
                access_token_reference_id = excluded.access_token_reference_id,
                refresh_token_reference_id = excluded.refresh_token_reference_id,
                expires_at = excluded.expires_at,
                refresh_expires_at = excluded.refresh_expires_at,
                updated_at = excluded.updated_at
            `)
              .bind(
                input.id,
                input.userId,
                input.providerAccountId,
                input.providerAccountLogin,
                input.status,
                input.accessTokenReferenceId ?? null,
                input.refreshTokenReferenceId ?? null,
                input.expiresAt ?? null,
                input.refreshExpiresAt ?? null,
                input.now,
                input.now,
              )
              .run()
              .then(() => undefined),
          catch: unavailable("source-control.github.saveUserAuthorization"),
        }),
      saveInstallation: (input) =>
        Effect.tryPromise({
          try: () =>
            db
              .prepare(`
            INSERT INTO github_installation (
              installation_id, app_id, provider_account_id, provider_account_type,
              provider_account_login, repository_selection, status,
              permissions_version, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(installation_id) DO UPDATE SET
              app_id = excluded.app_id,
              provider_account_id = excluded.provider_account_id,
              provider_account_type = excluded.provider_account_type,
              provider_account_login = excluded.provider_account_login,
              repository_selection = excluded.repository_selection,
              status = excluded.status,
              permissions_version = excluded.permissions_version,
              updated_at = excluded.updated_at
          `)
              .bind(
                input.installationId,
                input.appId,
                input.providerAccountId,
                input.providerAccountType,
                input.providerAccountLogin,
                input.repositorySelection,
                input.status,
                input.permissionsVersion,
                input.now,
                input.now,
              )
              .run()
              .then(() => undefined),
          catch: unavailable("source-control.github.saveInstallation"),
        }),
      bindOwner: (input) =>
        Effect.tryPromise({
          try: () =>
            db
              .prepare(`
            INSERT INTO github_owner_grant (
              id, owner_scope, owner_id, installation_id, status,
              created_by_user_id, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
            ON CONFLICT(owner_scope, owner_id, installation_id) DO UPDATE SET
              status = 'active', updated_at = excluded.updated_at
          `)
              .bind(
                input.id,
                input.ownerScope,
                input.ownerId,
                input.installationId,
                input.createdByUserId,
                input.now,
                input.now,
              )
              .run()
              .then(() => undefined),
          catch: unavailable("source-control.github.bindOwner"),
        }),
      replaceEntitlements: (installationId, repositories, now) =>
        Effect.tryPromise({
          try: () =>
            db
              .batch([
                db
                  .prepare(
                    "UPDATE github_installation_repository SET entitled = 0, last_reconciled_at = ? WHERE installation_id = ?",
                  )
                  .bind(now, installationId),
                ...repositories.map((repository) =>
                  db
                    .prepare(`
              INSERT INTO github_installation_repository (
                installation_id, provider_repository_id, full_name, web_url,
                visibility, entitled, last_reconciled_at
              ) VALUES (?, ?, ?, ?, ?, 1, ?)
              ON CONFLICT(installation_id, provider_repository_id) DO UPDATE SET
                full_name = excluded.full_name, web_url = excluded.web_url,
                visibility = excluded.visibility, entitled = 1,
                last_reconciled_at = excluded.last_reconciled_at
            `)
                    .bind(
                      installationId,
                      repository.providerRepositoryId,
                      repository.fullName,
                      repository.webUrl,
                      repository.visibility,
                      now,
                    ),
                ),
              ])
              .then(() => undefined),
          catch: unavailable("source-control.github.replaceEntitlements"),
        }),
      insertSetupTransaction: (input) =>
        Effect.tryPromise({
          try: () =>
            db
              .prepare(`
                INSERT INTO github_setup_transaction (
                  id, state_hash, actor_user_id, browser_session_id,
                  owner_scope, owner_id, status, verifier_reference_id,
                  expires_at, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
              `)
              .bind(
                input.id,
                input.stateHash,
                input.actorUserId,
                input.browserSessionId,
                input.ownerScope,
                input.ownerId,
                input.verifierReferenceId,
                input.expiresAt,
                input.now,
              )
              .run()
              .then(() => undefined),
          catch: unavailable("source-control.github.insertSetupTransaction"),
        }),
      claimWebhookDelivery: (input) =>
        Effect.tryPromise({
          try: () =>
            db
              .prepare(`
                INSERT OR IGNORE INTO github_webhook_delivery (
                  delivery_id, event, action, payload_sha256, state, attempts,
                  installation_id, received_at, updated_at, expires_at
                ) VALUES (?, ?, ?, ?, 'received', 0, ?, ?, ?, ?)
              `)
              .bind(
                input.deliveryId,
                input.event,
                input.action,
                input.payloadSha256,
                input.installationId ?? null,
                input.now,
                input.now,
                input.expiresAt,
              )
              .run()
              .then((result) => result.meta.changes === 1),
          catch: unavailable("source-control.github.claimWebhookDelivery"),
        }),
      incrementAuthorizationEpoch: (subjectKind, subjectId, now) =>
        Effect.tryPromise({
          try: async () => {
            await db
              .prepare(`
              INSERT INTO github_authorization_epoch (
                subject_kind, subject_id, epoch, updated_at
              ) VALUES (?, ?, 2, ?)
              ON CONFLICT(subject_kind, subject_id) DO UPDATE SET
                epoch = epoch + 1, updated_at = excluded.updated_at
            `)
              .bind(subjectKind, subjectId, now)
              .run();
            const row = await db
              .prepare(
                "SELECT epoch FROM github_authorization_epoch WHERE subject_kind = ? AND subject_id = ?",
              )
              .bind(subjectKind, subjectId)
              .first<{ epoch: number }>();
            if (row === null) throw new Error("missing epoch");
            return row.epoch;
          },
          catch: unavailable(
            "source-control.github.incrementAuthorizationEpoch",
          ),
        }),
    } satisfies GitHubRepositoryShape),
  );
