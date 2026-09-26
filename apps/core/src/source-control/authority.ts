import { SourceControlAccessDenied } from "@dx/domain";

export type SourceOwner = {
  readonly scope: "personal" | "workspace";
  readonly id: string;
};

export interface LiveGrantAuthority {
  readonly installation_id: string;
  readonly grant_status: string;
  readonly installation_status: string;
  readonly entitled: number;
  readonly grant_epoch: number;
  readonly installation_epoch: number;
  readonly policy_revision: number;
}

export const sourceAccessDenied = (
  reason: ConstructorParameters<typeof SourceControlAccessDenied>[0]["reason"],
  action: ConstructorParameters<typeof SourceControlAccessDenied>[0]["action"],
) => new SourceControlAccessDenied({ reason, action });

export const readLiveGrantAuthority = async (
  db: D1Database,
  owner: SourceOwner,
  grantId: string,
  repositoryId: string,
) =>
  db
    .prepare(`
      SELECT grant_row.installation_id, grant_row.status AS grant_status,
             installation.status AS installation_status,
             CASE WHEN entitlement.entitled = 1 THEN 1 ELSE 0 END AS entitled,
             COALESCE(grant_epoch.epoch, 1) AS grant_epoch,
             COALESCE(installation_epoch.epoch, 1) AS installation_epoch,
             CASE WHEN grant_row.owner_scope = 'workspace'
               THEN COALESCE(policy.revision, 0) ELSE 0 END AS policy_revision
        FROM github_owner_grant AS grant_row
        JOIN github_installation AS installation
          ON installation.installation_id = grant_row.installation_id
        LEFT JOIN github_installation_repository AS entitlement
          ON entitlement.installation_id = grant_row.installation_id
         AND entitlement.provider_repository_id = ?
        LEFT JOIN github_authorization_epoch AS grant_epoch
          ON grant_epoch.subject_kind = 'owner-grant' AND grant_epoch.subject_id = grant_row.id
        LEFT JOIN github_authorization_epoch AS installation_epoch
          ON installation_epoch.subject_kind = 'installation'
         AND installation_epoch.subject_id = grant_row.installation_id
        LEFT JOIN workspace_policy AS policy
          ON grant_row.owner_scope = 'workspace' AND policy.workspace_id = grant_row.owner_id
       WHERE grant_row.id = ? AND grant_row.owner_scope = ? AND grant_row.owner_id = ?
       LIMIT 1
    `)
    .bind(repositoryId, grantId, owner.scope, owner.id)
    .first<LiveGrantAuthority>();

export const validateLiveGrantAuthority = (row: LiveGrantAuthority | null) => {
  if (row === null) throw sourceAccessDenied("grant-missing", "reconnect");
  if (row.grant_status !== "active")
    throw sourceAccessDenied(
      row.grant_status === "disconnected"
        ? "grant-disconnected"
        : "connection-reauthorization-required",
      "reconnect",
    );
  if (row.installation_status !== "active")
    throw sourceAccessDenied(
      row.installation_status === "suspended"
        ? "installation-suspended"
        : row.installation_status === "permissions-pending"
          ? "installation-permissions-changed"
          : "installation-removed",
      "reconfigure",
    );
  if (row.entitled !== 1)
    throw sourceAccessDenied("repository-access-removed", "rebind");
  return row;
};
