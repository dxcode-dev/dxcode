import type { DeleteProjectData, DeleteProjectRequest } from "@dx/api";
import { PROJECTLESS_PROJECT_NAME, type ThreadId } from "@dx/domain";
import { projectPersistenceLogger } from "../logging.js";
import { activeMemberSql } from "../settings/members/membership-sql.js";
import { tombstoneStatements } from "../thread-deletion/tombstone.js";

/** The project is missing, already deleted, or not the user's to delete. */
export class ProjectDeletionNotFound extends Error {}

/** The typed confirmation does not match the project's name. */
export class ProjectDeletionNameMismatch extends Error {}

export interface ProjectDeletion extends DeleteProjectData {
  /** Every Thread the deletion changed, for realtime invalidation. */
  readonly changedThreadIds: ReadonlyArray<ThreadId>;
  /** The owners of those Threads, whose sidebars change. */
  readonly ownerUserIds: ReadonlyArray<string>;
  /** Kept Threads whose Orb may be running; each is stopped after. */
  readonly runningKeptThreadIds: ReadonlyArray<ThreadId>;
  /** Tombstoned Threads whose history, Orb, and files are purged after. */
  readonly deletedThreads: ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly ownerUserId: string;
  }>;
  /** The project icon's storage key, deleted after. */
  readonly iconKey?: string;
}

/**
 * A project the user may delete: their private project, or a workspace
 * project they created or administer while an active member. `?1` is the
 * project ID and `?2` the user. The projectless scope is never deleted.
 */
const deletableProject = `projects.id = ?1
  AND projects.deleted_at IS NULL
  AND projects.name != '${PROJECTLESS_PROJECT_NAME}'
  AND ((projects.workspace_id IS NULL AND projects.owner_user_id = ?2)
    OR (projects.workspace_id IS NOT NULL
      AND ${activeMemberSql("projects.workspace_id", "?2")}
      AND (projects.owner_user_id = ?2 OR EXISTS (
        SELECT 1 FROM member
         WHERE member.userId = ?2
           AND member.organizationId = projects.workspace_id
           AND member.role IN ('owner', 'admin')))))`;

/** `?1` is the project ID in each statement below. */
const projectThreads = "SELECT id FROM threads WHERE project_id = ?1";

/**
 * Deletes a project for good (#1128). It is a soft delete: the row stays,
 * with `deleted_at` set, so Threads, usage, and audit rows still point at
 * it, but the project leaves every list and picker and its name is free.
 * In one D1 transaction:
 *
 * - every Thread in the project is deleted, or kept by its owner archived
 *   and read-only, as `input.threads` says; kept Threads stop being shared
 *   with the workspace;
 * - schedules and GitHub subscriptions of its Threads, and subscriptions
 *   that start Threads in it, stop;
 * - its secrets and environment variables are erased.
 *
 * Stopping Orbs, purging deleted Threads, and removing the icon happen
 * after, from the result.
 */
export const deleteProject = async (
  db: D1Database,
  userId: string,
  projectId: string,
  input: DeleteProjectRequest,
): Promise<ProjectDeletion> => {
  const [projectRows, threadRows] = await db.batch<{
    id: ThreadId;
    name: string;
    icon_key: string | null;
    owner_user_id: string;
    running: number;
  }>([
    db
      .prepare(
        `SELECT projects.id, projects.name, projects.icon_key FROM projects
          WHERE ${deletableProject}`,
      )
      .bind(projectId, userId),
    db
      .prepare(
        `SELECT threads.id, threads.owner_user_id,
                EXISTS (SELECT 1 FROM execution_workspace
                         WHERE execution_workspace.thread_id = threads.id
                           AND execution_workspace.state IN ('provisioning', 'initialized')
                       ) AS running
           FROM threads
          WHERE threads.project_id = ?1
            AND threads.lifecycle_state != 'deleted'`,
      )
      .bind(projectId),
  ]);
  const project = projectRows?.results[0];
  if (project === undefined) throw new ProjectDeletionNotFound();
  if (
    input.confirmName.trim().toLowerCase() !== project.name.trim().toLowerCase()
  )
    throw new ProjectDeletionNameMismatch();
  const threads = threadRows?.results ?? [];
  const deleting = input.threads === "delete" ? threads : [];
  const now = new Date().toISOString();
  // Every statement after the first applies only once this request has
  // deleted the project.
  const deletedNow =
    "EXISTS (SELECT 1 FROM projects WHERE id = ?1 AND deleted_at = ?2)";
  const statement = (sql: string) => db.prepare(sql).bind(projectId, now);
  const results = await db.batch([
    db
      .prepare(
        `UPDATE projects
            SET deleted_at = ?3, icon_key = NULL, revision = revision + 1,
                updated_at = ?3
          WHERE ${deletableProject}
         RETURNING id`,
      )
      .bind(projectId, userId, now),
    ...(deleting.length === 0
      ? []
      : tombstoneStatements(
          db,
          deleting.map(({ id }) => id),
          null,
          now,
        )),
    // Every other Thread stays with its owner, archived; a Thread in a
    // deleted project is never unarchived, and no one else reaches it.
    statement(
      `UPDATE threads
          SET lifecycle_state = 'archived', pinned_at = NULL,
              snoozed_until = NULL, snoozed_at = NULL,
              workspace_access = 'none', shared_workspace_id = NULL,
              contribute_until = NULL, updated_at = ?2
        WHERE project_id = ?1 AND lifecycle_state != 'deleted'
          AND ${deletedNow}`,
    ),
    // Nothing wakes a kept Thread or starts one in the deleted project.
    statement(
      `DELETE FROM thread_schedule
        WHERE thread_id IN (${projectThreads}) AND ${deletedNow}`,
    ),
    statement(
      `DELETE FROM github_subscription
        WHERE (thread_id IN (${projectThreads}) OR project_id = ?1)
          AND ${deletedNow}`,
    ),
    statement(
      `DELETE FROM environment_variable
        WHERE scope = 'project' AND target_id = ?1 AND ${deletedNow}`,
    ),
  ]);
  if (results[0]?.results.length !== 1) throw new ProjectDeletionNotFound();
  const tombstoned = new Set(
    deleting.length === 0
      ? []
      : (results[1]?.results ?? []).map((row) => (row as { id: string }).id),
  );
  const deletedThreads = deleting
    .filter(({ id }) => tombstoned.has(id))
    .map(({ id, owner_user_id }) => ({
      threadId: id,
      ownerUserId: owner_user_id,
    }));
  const kept = threads.filter(({ id }) => !tombstoned.has(id));
  projectPersistenceLogger.info("Project deleted.", {
    event: "project_deleted",
    projectId,
    userId,
    keptThreads: kept.length,
    deletedThreads: deletedThreads.length,
  });
  return {
    deleted: true,
    keptThreadCount: kept.length,
    deletedThreadCount: deletedThreads.length,
    changedThreadIds: threads.map(({ id }) => id),
    ownerUserIds: [...new Set(threads.map((row) => row.owner_user_id))],
    runningKeptThreadIds: kept
      .filter(({ running }) => running === 1)
      .map(({ id }) => id),
    deletedThreads,
    ...(project.icon_key === null ? {} : { iconKey: project.icon_key }),
  };
};
