import type { ProjectViewerAccess } from "@dx/api";
import { activeMemberSql } from "../settings/members/membership-sql.js";

interface AccessRow {
  readonly id: string;
  readonly can_manage: number;
  readonly authority_provider: string | null;
  readonly authority_owner_scope: string | null;
  readonly authority_owner_id: string | null;
  readonly github_entitled: number;
  readonly github_connected: number;
  readonly bitbucket_connected: number;
}

const BATCH = 50;

/**
 * Computes whether the user can manage each Project and start Threads in it,
 * from local D1 state only (no provider calls). A Project bound through
 * another member's grant needs the user's own connection: a GitHub grant whose
 * installation is entitled to the repository, or a live Bitbucket connection
 * (Bitbucket itself decides repository access at admission).
 */
export const projectViewerAccess = async (
  db: D1Database,
  userId: string,
  projectIds: ReadonlyArray<string>,
): Promise<ReadonlyMap<string, ProjectViewerAccess>> => {
  const access = new Map<string, ProjectViewerAccess>();
  for (let index = 0; index < projectIds.length; index += BATCH) {
    const ids = projectIds.slice(index, index + BATCH);
    const result = await db
      .prepare(
        `SELECT project.id,
                CASE WHEN project.workspace_id IS NULL
                       OR (${activeMemberSql("project.workspace_id", "?1")}
                         AND (project.owner_user_id = ?1 OR EXISTS (
                           SELECT 1 FROM member
                            WHERE member.userId = ?1
                              AND member.organizationId = project.workspace_id
                              AND member.role IN ('owner', 'admin'))))
                     THEN 1 ELSE 0 END AS can_manage,
                authority.provider AS authority_provider,
                authority.owner_scope AS authority_owner_scope,
                authority.owner_id AS authority_owner_id,
                EXISTS (
                  SELECT 1 FROM github_owner_grant AS grant_row
                    JOIN github_installation AS installation
                      ON installation.installation_id = grant_row.installation_id
                    JOIN github_installation_repository AS entitlement
                      ON entitlement.installation_id = grant_row.installation_id
                     AND entitlement.provider_repository_id = authority.provider_repository_id
                   WHERE grant_row.owner_scope = 'personal' AND grant_row.owner_id = ?1
                     AND grant_row.status = 'active' AND installation.status = 'active'
                     AND entitlement.entitled = 1
                ) AS github_entitled,
                EXISTS (
                  SELECT 1 FROM github_owner_grant
                   WHERE owner_scope = 'personal' AND owner_id = ?1 AND status = 'active'
                ) AS github_connected,
                EXISTS (
                  SELECT 1 FROM bitbucket_connection
                   WHERE user_id = ?1 AND status = 'active'
                ) AS bitbucket_connected
           FROM projects AS project
           LEFT JOIN project_repository AS repository
             ON repository.project_id = project.id
           LEFT JOIN project_source_authority AS authority
             ON authority.project_id = repository.project_id
            AND authority.binding_revision = repository.binding_revision
            AND authority.provenance = 'live-grant'
          WHERE project.id IN (${ids.map((_, position) => `?${position + 2}`).join(", ")})`,
      )
      .bind(userId, ...ids)
      .all<AccessRow>();
    for (const row of result.results) {
      const provider = row.authority_provider;
      const threads: ProjectViewerAccess["threads"] =
        provider === null ||
        // A workspace-owned grant serves every active member.
        row.authority_owner_scope === "workspace" ||
        row.authority_owner_id === userId ||
        (provider === "github" && row.github_entitled === 1) ||
        (provider === "bitbucket" && row.bitbucket_connected === 1) ||
        (provider !== "github" && provider !== "bitbucket")
          ? { status: "available" }
          : provider === "github" && row.github_connected === 1
            ? { status: "no-repository-access", provider }
            : { status: "connect", provider };
      access.set(row.id, { canManage: row.can_manage === 1, threads });
    }
  }
  return access;
};
