import type { Principal, UserId } from "@dx/domain";
import {
  activeMemberSql,
  threadProjectReachableSql,
} from "../settings/members/membership-sql.js";

export type SharedThreadAccess = "contribute" | "view";

/**
 * SQL predicate: the Thread is shared with a workspace that both `userId`
 * and the Thread owner actively belong to, and the owner still reaches the
 * Thread's Project. `thread` and `project` are table aliases; `userId` is a
 * trusted SQL expression (column or placeholder).
 */
export const sharedThreadVisibleSql = (
  thread: string,
  project: string,
  userId: string,
) => `(
  ${thread}.workspace_access IN ('view', 'contribute')
  -- Matches the partial index threads_shared_workspace_idx.
  AND ${thread}.workspace_access != 'none'
  AND ${thread}.shared_workspace_id IS NOT NULL
  AND ${thread}.owner_user_id != ${userId}
  AND ${activeMemberSql(`${thread}.shared_workspace_id`, userId)}
  AND ${activeMemberSql(`${thread}.shared_workspace_id`, `${thread}.owner_user_id`)}
  AND ${threadProjectReachableSql(project, `${thread}.owner_user_id`)})`;

/** SQL expression: the effective member access at `now` (ISO placeholder). */
export const sharedThreadAccessSql = (thread: string, now: string) => `
  CASE WHEN ${thread}.workspace_access = 'contribute'
         AND ${thread}.contribute_until IS NOT NULL
         AND ${thread}.contribute_until > ${now}
       THEN 'contribute' ELSE 'view' END`;

export interface SharedThreadGrant {
  readonly ownerUserId: UserId;
  readonly lifecycleState: "active" | "archived";
  readonly access: SharedThreadAccess;
}

/** A member's access to another member's shared Thread, if any. */
export const findSharedThreadGrant = async (
  db: D1Database,
  threadId: string,
  userId: string,
  now = new Date(),
): Promise<SharedThreadGrant | undefined> => {
  const row = await db
    .prepare(
      `SELECT thread.owner_user_id, thread.lifecycle_state,
              ${sharedThreadAccessSql("thread", "?3")} AS access
         FROM threads AS thread
         JOIN projects AS project ON project.id = thread.project_id
        WHERE thread.id = ?1
          AND thread.lifecycle_state != 'deleted'
          AND ${sharedThreadVisibleSql("thread", "project", "?2")}`,
    )
    .bind(threadId, userId, now.toISOString())
    .first<{
      owner_user_id: string;
      lifecycle_state: "active" | "archived";
      access: SharedThreadAccess;
    }>();
  return row === null
    ? undefined
    : {
        ownerUserId: row.owner_user_id as UserId,
        lifecycleState: row.lifecycle_state,
        access: row.access,
      };
};

/**
 * Only signed-in people use shared Threads. External applications act for
 * their own Threads only.
 */
export const canUseSharedThreads = (principal: Principal) =>
  principal.application === undefined;

/**
 * The owner's identity for a member acting in a shared Thread. Scopes stay
 * the actor's, but every user-keyed lookup now resolves as the owner.
 */
export const impersonateThreadOwner = (
  actor: Principal,
  ownerUserId: UserId,
): Principal => ({ ...actor, userId: ownerUserId });

/**
 * Whether a member with View access may make this request. Viewers read the
 * conversation, Changes, and Files, and follow the Thread; they cannot
 * prompt, stop, write files, or open the terminal.
 */
export const viewerMayRequest = (method: string, path: string) =>
  (["GET", "HEAD", "OPTIONS"].includes(method) &&
    !/\/terminal\/?$/.test(path)) ||
  // Following changes only the viewer's own sidebar.
  (["PUT", "DELETE"].includes(method) && /\/follow\/?$/.test(path));
