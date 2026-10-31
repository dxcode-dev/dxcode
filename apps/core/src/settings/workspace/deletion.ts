import type { DeleteWorkspaceData, DeleteWorkspaceRequest } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { settingsAuditLogger } from "../../logging.js";
import { tombstoneStatements } from "../../thread-deletion/tombstone.js";
import {
  requireOwner,
  type WorkspaceAccess,
  WorkspaceMembersError,
} from "../members/service.js";
import {
  revokeWorkspaceCredentials,
  type WorkspaceCredentialRevoker,
} from "./credential-revocation.js";

/** `?1` is the workspace ID in every statement below. */
const workspaceProjects = "SELECT id FROM projects WHERE workspace_id = ?1";
const workspaceThreads = `SELECT id FROM threads WHERE project_id IN (${workspaceProjects})`;

export interface WorkspaceDeletion extends DeleteWorkspaceData {
  /** Kept Threads whose Orb may be running; each is stopped after. */
  readonly runningKeptThreadIds: ReadonlyArray<ThreadId>;
  /** Tombstoned Threads whose history, Orb, and files are purged after. */
  readonly deletedThreads: ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly ownerUserId: string;
  }>;
  /** The workspace picture's storage key, deleted after. */
  readonly avatarKey?: string;
}

/**
 * Deletes the workspace for good, as its owner (#1158). It is a soft
 * delete: the organization row stays so projects, usage, and audit rows
 * still point at it, but in one D1 transaction:
 *
 * - every Thread in its Projects is deleted, or kept by its owner archived
 *   and read-only, as `input.threads` says; Threads shared with the
 *   workspace stop being shared;
 * - its Projects are soft deleted (`projects.deleted_at`);
 * - its secrets, keys, connections, and settings are erased or revoked;
 *   before that, each provider is asked to revoke the OAuth tokens erased
 *   (`credential-revocation.ts`);
 * - its invites and memberships are removed, and its short name is freed.
 *
 * Stopping Orbs and purging deleted Threads happen after, from the result.
 */
export const deleteWorkspace = async (
  db: D1Database,
  access: WorkspaceAccess,
  input: DeleteWorkspaceRequest,
  revoker?: WorkspaceCredentialRevoker,
): Promise<WorkspaceDeletion> => {
  requireOwner(access);
  if (
    input.confirmShortName.trim().toLowerCase() !==
    access.shortName.toLowerCase()
  )
    throw new WorkspaceMembersError(
      "INVALID_WORKSPACE_MEMBERS_REQUEST",
      400,
      "Type the workspace short name to confirm.",
      {
        fieldErrors: [
          {
            field: "confirmShortName",
            message: `Type ${access.shortName} to confirm.`,
          },
        ],
      },
    );
  const workspaceId = access.workspaceId;
  // Providers are asked to revoke the tokens before dx erases them, while
  // they can still be read. Best effort: this never throws.
  if (revoker !== undefined)
    await revokeWorkspaceCredentials(db, workspaceId, access.userId, revoker);
  const now = new Date().toISOString();
  const [threadRows, organization] = await db.batch<{
    id: ThreadId;
    owner_user_id: string;
    lifecycle_state: string;
    running: number;
    avatar_key: string | null;
  }>([
    db
      .prepare(
        `SELECT threads.id, threads.owner_user_id, threads.lifecycle_state,
                EXISTS (SELECT 1 FROM execution_workspace
                         WHERE execution_workspace.thread_id = threads.id
                           AND execution_workspace.state IN ('provisioning', 'initialized')
                       ) AS running
           FROM threads
          WHERE threads.project_id IN (${workspaceProjects})
            AND threads.lifecycle_state != 'deleted'`,
      )
      .bind(workspaceId),
    db
      .prepare("SELECT avatar_key FROM organization WHERE id = ?1")
      .bind(workspaceId),
  ]);
  const threads = threadRows?.results ?? [];
  const deleting = input.threads === "delete" ? threads : [];
  const statement = (sql: string) =>
    sql.includes("?2")
      ? db.prepare(sql).bind(workspaceId, now)
      : db.prepare(sql).bind(workspaceId);
  const results = await db.batch([
    ...(deleting.length === 0
      ? []
      : tombstoneStatements(
          db,
          deleting.map(({ id }) => id),
          null,
          now,
        )),
    // Every other Thread in its Projects stays with its owner, archived; a
    // Thread in a deleted Project is never unarchived.
    statement(
      `UPDATE threads
          SET lifecycle_state = 'archived', pinned_at = NULL,
              snoozed_until = NULL, snoozed_at = NULL,
              workspace_access = 'none', shared_workspace_id = NULL,
              contribute_until = NULL, updated_at = ?2
        WHERE project_id IN (${workspaceProjects})
          AND lifecycle_state != 'deleted'`,
    ),
    statement(
      `UPDATE threads
          SET workspace_access = 'none', shared_workspace_id = NULL,
              contribute_until = NULL
        WHERE shared_workspace_id = ?1`,
    ),
    // Nothing wakes a kept Thread or starts one in a deleted Project.
    statement(
      `DELETE FROM thread_schedule WHERE thread_id IN (${workspaceThreads})`,
    ),
    statement(
      `DELETE FROM github_subscription
        WHERE thread_id IN (${workspaceThreads})
           OR project_id IN (${workspaceProjects})`,
    ),
    statement(
      `UPDATE projects SET deleted_at = ?2
        WHERE workspace_id = ?1 AND deleted_at IS NULL`,
    ),
    // Secrets and keys.
    statement(
      `DELETE FROM environment_variable
        WHERE (scope = 'workspace' AND target_id = ?1)
           OR (scope = 'project' AND target_id IN (${workspaceProjects}))`,
    ),
    statement(
      "DELETE FROM mcp_server WHERE scope = 'workspace' AND target_id = ?1",
    ),
    statement(
      "DELETE FROM model_connection WHERE scope = 'workspace' AND target_id = ?1",
    ),
    statement(
      "DELETE FROM model_credential WHERE scope = 'workspace' AND target_id = ?1",
    ),
    statement(
      "DELETE FROM orb_connection WHERE scope = 'workspace' AND target_id = ?1",
    ),
    statement(
      "DELETE FROM execution_account_template WHERE scope = 'workspace' AND target_id = ?1",
    ),
    statement(
      "DELETE FROM plugin_setting WHERE scope = 'workspace' AND target_id = ?1",
    ),
    statement(
      "DELETE FROM dictation_vocabulary WHERE scope = 'workspace' AND target_id = ?1",
    ),
    // Connections. Each provider was asked to revoke its tokens first.
    statement(
      `UPDATE integration_connection
          SET status = 'disconnected', health = 'revoked',
              access_token_reference_id = NULL,
              refresh_token_reference_id = NULL,
              revoked_at = ?2, updated_at = ?2
        WHERE owner_scope = 'workspace' AND owner_id = ?1`,
    ),
    ...[
      "integration_oauth_transaction",
      "github_setup_transaction",
      "github_oauth_transaction",
    ].map((table) =>
      statement(
        `DELETE FROM ${table}
          WHERE verifier_reference_id IN (
            SELECT id FROM integration_credential
             WHERE owner_scope = 'workspace' AND owner_id = ?1)`,
      ),
    ),
    statement(
      `DELETE FROM integration_credential
        WHERE owner_scope = 'workspace' AND owner_id = ?1`,
    ),
    statement(
      `DELETE FROM github_owner_repository_selection
        WHERE owner_grant_id IN (
          SELECT id FROM github_owner_grant
           WHERE owner_scope = 'workspace' AND owner_id = ?1)`,
    ),
    statement(
      `UPDATE github_owner_grant SET status = 'disconnected', updated_at = ?2
        WHERE owner_scope = 'workspace' AND owner_id = ?1
          AND status != 'disconnected'`,
    ),
    statement(
      `UPDATE external_api_application_credential SET revoked_at = ?2
        WHERE revoked_at IS NULL AND application_id IN (
          SELECT id FROM external_api_application WHERE workspace_id = ?1)`,
    ),
    statement(
      `UPDATE external_api_application
          SET status = 'revoked', revoked_at = ?2, updated_at = ?2
        WHERE workspace_id = ?1 AND status != 'revoked'`,
    ),
    // Skills and plugins keep their audit history; triggers stop.
    statement(
      `UPDATE skill SET enabled = 0, removed_at = ?2, updated_at = ?2
        WHERE scope = 'workspace' AND target_id = ?1 AND removed_at IS NULL`,
    ),
    statement(
      `UPDATE plugin_trigger
          SET status = 'revoked', revoked_at = ?2, updated_at = ?2
        WHERE status != 'revoked' AND plugin_id IN (
          SELECT id FROM trusted_plugin
           WHERE scope = 'workspace' AND target_id = ?1)`,
    ),
    statement(
      `UPDATE trusted_plugin SET enabled = 0, removed_at = ?2, updated_at = ?2
        WHERE scope = 'workspace' AND target_id = ?1 AND removed_at IS NULL`,
    ),
    // Settings and policies.
    ...[
      "workspace_project_defaults",
      "workspace_mode_profile_override",
      "mcp_workspace_policy",
      "skill_workspace_policy",
      "trusted_plugin_workspace_policy",
      "workspace_policy",
    ].map((table) => statement(`DELETE FROM ${table} WHERE workspace_id = ?1`)),
    // Invites and members.
    statement("DELETE FROM workspace_invite_link WHERE organization_id = ?1"),
    statement('DELETE FROM "invitation" WHERE "organizationId" = ?1'),
    statement(
      'UPDATE "session" SET "activeOrganizationId" = NULL WHERE "activeOrganizationId" = ?1',
    ),
    statement('DELETE FROM "member" WHERE "organizationId" = ?1'),
    // The short name is free again; the row stays for what points at it.
    db
      .prepare(
        `UPDATE organization
            SET deletedAt = ?2, avatar_key = NULL,
                slug = 'deleted-' || lower(hex(randomblob(8)))
          WHERE id = ?1 AND deletedAt IS NULL
          RETURNING id`,
      )
      .bind(workspaceId, now),
  ]);
  if (results.at(-1)?.results.length !== 1)
    throw new WorkspaceMembersError(
      "SETTINGS_SCOPE_FORBIDDEN",
      403,
      "The settings scope is unavailable for this user.",
    );
  const tombstoned = new Set(
    deleting.length === 0
      ? []
      : (results[0]?.results ?? []).map((row) => (row as { id: string }).id),
  );
  const deletedThreads = deleting
    .filter(({ id }) => tombstoned.has(id))
    .map(({ id, owner_user_id }) => ({
      threadId: id,
      ownerUserId: owner_user_id,
    }));
  const kept = threads.filter(({ id }) => !tombstoned.has(id));
  settingsAuditLogger.info("Workspace deleted.", {
    event: "workspace_deleted",
    workspaceId,
    userId: access.userId,
    keptThreads: kept.length,
    deletedThreads: deletedThreads.length,
  });
  const avatarKey = organization?.results[0]?.avatar_key ?? undefined;
  return {
    deleted: true,
    keptThreadCount: kept.length,
    deletedThreadCount: deletedThreads.length,
    runningKeptThreadIds: kept
      .filter(({ running }) => running === 1)
      .map(({ id }) => id),
    deletedThreads,
    ...(avatarKey === undefined ? {} : { avatarKey }),
  };
};
