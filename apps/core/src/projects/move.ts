import { PROJECTLESS_PROJECT_NAME, type ThreadId } from "@dx/domain";
import { activeMemberSql } from "../settings/members/membership-sql.js";

/** The project is missing, not the user's personal project, or stale. */
export class ProjectMoveNotFound extends Error {}

/** The workspace already has a project with this name. */
export class ProjectMoveNameConflict extends Error {}

export interface ProjectMoveInput {
  readonly projectId: string;
  readonly userId: string;
  readonly workspaceId: string;
  readonly revision: number;
  /** The Orb size the project keeps, already checked against the workspace. */
  readonly runnerProfileId: string;
  /** Public code access, already turned off when the workspace forbids it. */
  readonly publicCodeEnabled: boolean;
}

export interface ProjectMove {
  /** Every live Thread in the project, for realtime invalidation. */
  readonly threadIds: ReadonlyArray<ThreadId>;
  /**
   * Threads whose Orb may be running on the owner's personal Orb keys,
   * which the workspace does not allow; each is stopped after.
   */
  readonly personalOrbThreadIds: ReadonlyArray<ThreadId>;
}

/**
 * Moves the user's personal project into their workspace (Change Owner,
 * #1198), one way, in one D1 transaction. Nothing else is rewritten: every
 * access check reads `projects.workspace_id`, so from this write on members
 * see the project and start their own Threads in it, its own secrets,
 * variables, and Orb scripts reach their Orbs, and its creator and admins
 * manage it. The owner's Threads stay theirs and private unless shared, and
 * personal secrets, MCP servers, source connections, and Orb keys stay
 * personal: each resolves for the Thread's owner only. Personal Orb keys
 * stop serving the project's Threads unless the workspace allows them.
 */
export const moveProject = async (
  db: D1Database,
  input: ProjectMoveInput,
): Promise<ProjectMove> => {
  const now = new Date().toISOString();
  // The statements after the first apply only once this request moved it.
  const movedNow = `EXISTS (SELECT 1 FROM projects WHERE id = ?1
    AND workspace_id = ?2 AND updated_at = ?3)`;
  let results: ReadonlyArray<D1Result<{ id: string }>>;
  try {
    results = await db.batch<{ id: string }>([
      db
        .prepare(
          `UPDATE projects
              SET workspace_id = ?2, updated_at = ?3,
                  runner_profile_id = ?6, public_code_enabled = ?7,
                  revision = revision + 1
            WHERE id = ?1 AND owner_user_id = ?4 AND revision = ?5
              AND workspace_id IS NULL AND deleted_at IS NULL
              AND name != '${PROJECTLESS_PROJECT_NAME}'
              AND ${activeMemberSql("?2", "?4")}
            RETURNING id`,
        )
        .bind(
          input.projectId,
          input.workspaceId,
          now,
          input.userId,
          input.revision,
          input.runnerProfileId,
          input.publicCodeEnabled ? 1 : 0,
        ),
      db
        .prepare(
          `SELECT id FROM threads
            WHERE project_id = ?1 AND lifecycle_state != 'deleted'
              AND ${movedNow}`,
        )
        .bind(input.projectId, input.workspaceId, now),
      db
        .prepare(
          `SELECT threads.id
             FROM threads
             JOIN execution_workspace AS pin ON pin.thread_id = threads.id
             LEFT JOIN workspace_policy AS policy ON policy.workspace_id = ?2
            WHERE threads.project_id = ?1
              AND threads.lifecycle_state != 'deleted'
              AND pin.account_scope = 'personal'
              AND pin.state IN ('provisioning', 'initialized')
              AND NOT (COALESCE(policy.allow_personal_plugin_overrides, 0) = 1
                AND COALESCE(policy.allow_personal_execution_overrides, 0) = 1)
              AND ${movedNow}`,
        )
        .bind(input.projectId, input.workspaceId, now),
    ]);
  } catch (cause) {
    if (String(cause).includes("UNIQUE constraint failed"))
      throw new ProjectMoveNameConflict();
    throw cause;
  }
  const [moved, threads, personalOrbThreads] = results;
  if (moved?.results.length !== 1) throw new ProjectMoveNotFound();
  return {
    threadIds: (threads?.results ?? []).map(({ id }) => id as ThreadId),
    personalOrbThreadIds: (personalOrbThreads?.results ?? []).map(
      ({ id }) => id as ThreadId,
    ),
  };
};
