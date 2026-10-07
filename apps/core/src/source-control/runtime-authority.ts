import {
  PersistenceUnavailable,
  SourceControlAccessDenied,
  type SourceOperationRequestType,
} from "@dx/domain";
import { Context, Effect, Layer } from "effect";
import {
  readLiveGrantAuthority,
  sourceAccessDenied,
  validateLiveGrantAuthority,
} from "./authority.js";

export interface RuntimeSourceAuthority {
  readonly threadId: string;
  readonly projectId: string;
  readonly actorUserId: string;
  readonly provider: "github";
  readonly ownerScope: "personal" | "workspace";
  readonly ownerId: string;
  readonly grantId: string;
  readonly installationId: string;
  readonly providerAccountId: string;
  readonly providerRepositoryId: string;
  readonly repositoryName: string;
  readonly rootProviderRepositoryId: string;
  readonly bindingRevision: number;
  readonly authorizationEpoch: number;
  readonly installationEpoch: number;
  readonly policyRevision: number;
  readonly defaultBranch: string;
  readonly shipAction: "ship" | "commit";
  readonly repositorySelection: "all" | "selected";
  readonly fingerprint: string;
}

export interface SourceAuthorityRepositoryShape {
  readonly resolve: (
    threadId: string,
    actorUserId: string,
    request: SourceOperationRequestType,
    targetProviderRepositoryId?: string,
  ) => Effect.Effect<
    RuntimeSourceAuthority,
    SourceControlAccessDenied | PersistenceUnavailable
  >;
}

export class SourceAuthorityRepository extends Context.Service<
  SourceAuthorityRepository,
  SourceAuthorityRepositoryShape
>()("@dx/core/source-control/SourceAuthorityRepository") {}

const unavailable = (cause: unknown) =>
  PersistenceUnavailable.new(
    { operation: "source-control.runtime-authority.resolve" },
    cause,
  );

const number = (value: unknown) =>
  typeof value === "number" ? value : Number(value);

const string = (value: unknown) =>
  typeof value === "string" ? value : undefined;

export const SourceAuthorityRepositoryD1 = (db: D1Database) =>
  Layer.succeed(
    SourceAuthorityRepository,
    SourceAuthorityRepository.of({
      resolve: (threadId, actorUserId, _request, targetProviderRepositoryId) =>
        Effect.tryPromise({
          try: async () => {
            const row = await db
              .prepare(`
                SELECT thread.project_id, project.owner_user_id,
                       project.workspace_id, project.ship_action,
                       snapshot.provider AS snapshot_provider,
                       snapshot.binding_revision AS snapshot_binding_revision,
                       snapshot.repository_full_name AS snapshot_repository_name,
                       snapshot.default_branch,
                       thread_authority.owner_grant_id AS snapshot_grant_id,
                       thread_authority.installation_id AS snapshot_installation_id,
                       thread_authority.provider_repository_id AS snapshot_repository_id,
                       thread_authority.private_submodule_repository_ids_json,
                       thread_authority.authorization_epoch AS snapshot_grant_epoch,
                       thread_authority.installation_epoch AS snapshot_installation_epoch,
                       thread_authority.policy_revision AS snapshot_policy_revision,
                       binding.provider AS binding_provider,
                       binding.full_name AS binding_repository_name,
                       binding.binding_revision,
                       project_authority.owner_scope, project_authority.owner_id,
                       project_authority.owner_grant_id AS binding_grant_id,
                       project_authority.installation_id AS binding_installation_id,
                       project_authority.provider_repository_id AS binding_repository_id,
                       project_authority.provenance, project_authority.source_health,
                       project_authority.authorization_epoch,
                       project_authority.installation_epoch,
                       project_authority.policy_revision,
                       grant_row.created_by_user_id, installation.provider_account_id,
                       installation.repository_selection,
                       organization.lifecycleState AS workspace_lifecycle,
                       member.userId AS member_user_id
                  FROM threads AS thread
                  JOIN projects AS project ON project.id = thread.project_id
                  LEFT JOIN thread_source_snapshot AS snapshot ON snapshot.thread_id = thread.id
                  LEFT JOIN thread_source_authority AS thread_authority
                    ON thread_authority.thread_id = thread.id
                  LEFT JOIN project_repository AS binding ON binding.project_id = project.id
                  LEFT JOIN project_source_authority AS project_authority
                    ON project_authority.project_id = binding.project_id
                   AND project_authority.binding_revision = binding.binding_revision
                  LEFT JOIN github_owner_grant AS grant_row
                    ON grant_row.id = project_authority.owner_grant_id
                  LEFT JOIN github_installation AS installation
                    ON installation.installation_id = project_authority.installation_id
                  LEFT JOIN organization ON organization.id = project.workspace_id
                  LEFT JOIN member ON member.organizationId = project.workspace_id
                    AND member.userId = ?
                 WHERE thread.id = ? AND thread.owner_user_id = ?
                   AND project.owner_user_id = thread.owner_user_id
                 LIMIT 1
              `)
              .bind(actorUserId, threadId, actorUserId)
              .first<Record<string, unknown>>();
            if (row === null)
              throw sourceAccessDenied("source-not-found", "retry");
            const projectId = string(row.project_id);
            const provider = string(row.snapshot_provider);
            const ownerScope = string(row.owner_scope);
            const ownerId = string(row.owner_id);
            const grantId = string(row.binding_grant_id);
            const installationId = string(row.binding_installation_id);
            const repositoryId = string(row.binding_repository_id);
            if (
              projectId === undefined ||
              provider === undefined ||
              ownerScope === undefined ||
              ownerId === undefined ||
              grantId === undefined ||
              installationId === undefined ||
              repositoryId === undefined
            )
              throw sourceAccessDenied("stale-snapshot", "rebind");
            if (provider !== "github" || row.binding_provider !== "github")
              throw sourceAccessDenied("unsupported-provider", "rebind");
            if (ownerScope !== "personal" && ownerScope !== "workspace")
              throw sourceAccessDenied("stale-binding", "rebind");
            if (
              row.provenance !== "live-grant" ||
              row.source_health !== "available"
            )
              throw sourceAccessDenied("stale-binding", "rebind");
            if (
              // A personal grant authorizes only its own user, in a private
              // Project or a workspace Project the user is still a member of.
              (ownerScope === "personal" &&
                (ownerId !== actorUserId ||
                  row.owner_user_id !== actorUserId ||
                  row.created_by_user_id !== actorUserId ||
                  (row.workspace_id !== null &&
                    (row.workspace_lifecycle !== "active" ||
                      row.member_user_id !== actorUserId)))) ||
              (ownerScope === "workspace" &&
                (ownerId !== row.workspace_id ||
                  row.workspace_lifecycle !== "active" ||
                  row.member_user_id !== actorUserId))
            )
              throw sourceAccessDenied(
                ownerScope === "workspace"
                  ? "policy-denied"
                  : "source-not-found",
                ownerScope === "workspace"
                  ? "contact-workspace-admin"
                  : "retry",
              );
            const bindingRevision = number(row.binding_revision);
            const authorizationEpoch = number(row.authorization_epoch);
            const installationEpoch = number(row.installation_epoch);
            const policyRevision = number(row.policy_revision);
            if (
              row.snapshot_grant_id !== grantId ||
              row.snapshot_installation_id !== installationId ||
              row.snapshot_repository_id !== repositoryId ||
              number(row.snapshot_binding_revision) !== bindingRevision ||
              number(row.snapshot_grant_epoch) !== authorizationEpoch ||
              number(row.snapshot_installation_epoch) !== installationEpoch ||
              number(row.snapshot_policy_revision) !== policyRevision
            )
              throw sourceAccessDenied("stale-snapshot", "rebind");
            if (row.snapshot_repository_name !== row.binding_repository_name)
              throw sourceAccessDenied("stale-snapshot", "rebind");
            const privateSubmoduleIds = JSON.parse(
              string(row.private_submodule_repository_ids_json) ?? "[]",
            ) as unknown;
            if (
              !Array.isArray(privateSubmoduleIds) ||
              privateSubmoduleIds.some((id) => typeof id !== "string")
            )
              throw sourceAccessDenied("stale-snapshot", "rebind");
            const targetRepositoryId =
              targetProviderRepositoryId ?? repositoryId;
            if (
              targetRepositoryId !== repositoryId &&
              !privateSubmoduleIds.includes(targetRepositoryId)
            )
              throw sourceAccessDenied("repository-not-selected", "rebind");
            const targetRepositoryName =
              targetRepositoryId === repositoryId
                ? string(row.snapshot_repository_name)
                : string(
                    (
                      await db
                        .prepare(`
                          SELECT full_name
                            FROM github_installation_repository
                           WHERE installation_id = ?
                             AND provider_repository_id = ?
                             AND entitled = 1
                           LIMIT 1
                        `)
                        .bind(installationId, targetRepositoryId)
                        .first<Record<string, unknown>>()
                    )?.full_name,
                  );
            if (targetRepositoryName === undefined)
              throw sourceAccessDenied("repository-access-removed", "rebind");
            const live = validateLiveGrantAuthority(
              await readLiveGrantAuthority(
                db,
                { scope: ownerScope, id: ownerId },
                grantId,
                targetRepositoryId,
              ),
            );
            if (
              live.installation_id !== installationId ||
              live.grant_epoch !== authorizationEpoch ||
              live.installation_epoch !== installationEpoch ||
              live.policy_revision !== policyRevision
            )
              throw sourceAccessDenied("stale-authorization-epoch", "retry");
            const defaultBranch = string(row.default_branch);
            const providerAccountId = string(row.provider_account_id);
            const repositorySelection = string(row.repository_selection);
            const shipAction = string(row.ship_action);
            if (
              defaultBranch === undefined ||
              providerAccountId === undefined ||
              (repositorySelection !== "all" &&
                repositorySelection !== "selected") ||
              (shipAction !== "ship" && shipAction !== "commit")
            )
              throw sourceAccessDenied("stale-binding", "rebind");
            const fingerprint = JSON.stringify([
              provider,
              ownerScope,
              ownerId,
              grantId,
              installationId,
              providerAccountId,
              targetRepositoryId,
              targetRepositoryName,
              bindingRevision,
              authorizationEpoch,
              installationEpoch,
              policyRevision,
            ]);
            return {
              threadId,
              projectId,
              actorUserId,
              provider: "github" as const,
              ownerScope,
              ownerId,
              grantId,
              installationId,
              providerAccountId,
              providerRepositoryId: targetRepositoryId,
              repositoryName: targetRepositoryName,
              rootProviderRepositoryId: repositoryId,
              bindingRevision,
              authorizationEpoch,
              installationEpoch,
              policyRevision,
              defaultBranch,
              shipAction,
              repositorySelection,
              fingerprint,
            };
          },
          catch: (cause) =>
            cause instanceof SourceControlAccessDenied
              ? cause
              : unavailable(cause),
        }),
    }),
  );
