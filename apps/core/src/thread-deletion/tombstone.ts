import type { ThreadId, UserId } from "@dx/domain";
import { listedUnderParentSql } from "../threads/list-projection-d1.js";

/** The title a tombstone keeps: the real one is part of what was deleted. */
export const DELETED_THREAD_TITLE = "Deleted thread";

/** The JSON array of Thread IDs bound as `?1`. */
const inThreads = "SELECT value FROM json_each(?1)";

/** Whether the owner's Thread `column` names is deleted. */
const tombstoneOf = (column: string) => `${column} IN (
  SELECT id FROM threads
   WHERE id IN (${inThreads}) AND owner_user_id = ?2
     AND lifecycle_state = 'deleted'
)`;

/**
 * Turns the owner's live Threads into tombstones in one D1 transaction. Each
 * row stays, so its ID can never be issued again. Titles, instructions, and
 * snapshots are scrubbed. Their child Threads become top-level Threads.
 * Their notifications, sidebar placement, sharing records, and who saw them
 * are removed, and each deletion is recorded for cleanup. Returns the Threads
 * it tombstoned: one already deleted, or not the owner's, is left out.
 */
export const tombstoneThreads = async (
  db: D1Database,
  threadIds: ReadonlyArray<ThreadId>,
  ownerUserId: UserId,
  deletedAt: string,
): Promise<ReadonlyArray<ThreadId>> => {
  const ids = JSON.stringify(threadIds);
  const [tombstoned] = await db.batch([
    db
      .prepare(
        `UPDATE threads
            SET lifecycle_state = 'deleted',
                title = ?3,
                title_pending_until = NULL,
                agent_instructions = '',
                skill_snapshot_json = '[]',
                plugin_snapshot_json = '[]',
                pinned_at = NULL,
                snoozed_until = NULL,
                snoozed_at = NULL,
                color = NULL,
                parent_thread_id = NULL,
                visibility = 'private',
                workspace_access = 'none',
                shared_workspace_id = NULL,
                contribute_until = NULL,
                activity_status = 'idle',
                turn_settled_at = NULL,
                turn_failed = 0,
                updated_at = ?4
          WHERE id IN (${inThreads}) AND owner_user_id = ?2
            AND lifecycle_state != 'deleted'
         RETURNING id`,
      )
      .bind(ids, ownerUserId, DELETED_THREAD_TITLE, deletedAt),
    db
      .prepare(
        `INSERT INTO thread_deletion (thread_id, owner_user_id, requested_at)
         SELECT id, ?2, ?3 FROM threads WHERE ${tombstoneOf("id")}
         ON CONFLICT (thread_id) DO NOTHING`,
      )
      .bind(ids, ownerUserId, deletedAt),
    db
      .prepare(
        `UPDATE threads SET parent_thread_id = NULL
          WHERE ${tombstoneOf("parent_thread_id")}`,
      )
      .bind(ids, ownerUserId),
    db
      .prepare(`DELETE FROM notification WHERE ${tombstoneOf("thread_id")}`)
      .bind(ids, ownerUserId),
    db
      .prepare(
        `DELETE FROM sidebar_layout_entry
          WHERE kind = 'thread' AND ${tombstoneOf("item_id")}`,
      )
      .bind(ids, ownerUserId),
    db
      .prepare(
        `DELETE FROM thread_participant WHERE ${tombstoneOf("thread_id")}`,
      )
      .bind(ids, ownerUserId),
    db
      .prepare(`DELETE FROM thread_follower WHERE ${tombstoneOf("thread_id")}`)
      .bind(ids, ownerUserId),
    db
      .prepare(`DELETE FROM thread_seen WHERE ${tombstoneOf("thread_id")}`)
      .bind(ids, ownerUserId),
  ]);
  return (tombstoned?.results ?? []).map((row) => (row as { id: ThreadId }).id);
};

/** The child Threads a deletion of these Threads turns into top-level ones. */
export const childThreadIds = async (
  db: D1Database,
  threadIds: ReadonlyArray<ThreadId>,
) =>
  (
    await db
      .prepare(
        `SELECT id FROM threads
          WHERE parent_thread_id IN (${inThreads})
            AND lifecycle_state != 'deleted'`,
      )
      .bind(JSON.stringify(threadIds))
      .all<{ id: ThreadId }>()
  ).results.map(({ id }) => id);

/**
 * The owner's child Threads listed under this one, as the sidebar counts
 * them, most recent activity first, up to `limit`.
 */
export const listedChildThreadIds = async (
  db: D1Database,
  threadId: ThreadId,
  ownerUserId: UserId,
  limit: number,
) =>
  (
    await db
      .prepare(
        `SELECT child.id FROM threads AS child
           JOIN threads AS parent ON parent.id = child.parent_thread_id
           JOIN projects AS child_project ON child_project.id = child.project_id
          WHERE child.parent_thread_id = ?1 AND parent.owner_user_id = ?2
            AND ${listedUnderParentSql}
          ORDER BY COALESCE(child.last_activity_at, child.updated_at) DESC,
                   child.id DESC
          LIMIT ?3`,
      )
      .bind(threadId, ownerUserId, limit)
      .all<{ id: ThreadId }>()
  ).results.map(({ id }) => id);

export interface ThreadDeletionRecord {
  readonly threadId: ThreadId;
  readonly ownerUserId: UserId;
  readonly requestedAt: string;
  readonly completedAt: string | null;
}

/** The owner's record of deleting this Thread, if they deleted it. */
export const findOwnedDeletion = async (
  db: D1Database,
  threadId: ThreadId,
  ownerUserId: UserId,
): Promise<ThreadDeletionRecord | undefined> =>
  (await db
    .prepare(
      `SELECT thread_id AS threadId, owner_user_id AS ownerUserId,
              requested_at AS requestedAt, completed_at AS completedAt
         FROM thread_deletion
        WHERE thread_id = ? AND owner_user_id = ?`,
    )
    .bind(threadId, ownerUserId)
    .first<ThreadDeletionRecord>()) ?? undefined;

/**
 * Whether this ID is a deleted Thread's tombstone. With `ownerUserId`, only
 * that owner's: everyone else is told the Thread does not exist.
 */
export const isDeletedThread = async (
  db: D1Database,
  threadId: string,
  ownerUserId?: string,
): Promise<boolean> =>
  (await db
    .prepare(
      `SELECT 1 AS deleted FROM threads
        WHERE id = ?1 AND lifecycle_state = 'deleted'
          AND (?2 IS NULL OR owner_user_id = ?2)`,
    )
    .bind(threadId, ownerUserId ?? null)
    .first()) !== null;
