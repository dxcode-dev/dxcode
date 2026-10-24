import type { ThreadId, UserId } from "@dx/domain";

/** The title a tombstone keeps: the real one is part of what was deleted. */
export const DELETED_THREAD_TITLE = "Deleted thread";

/** Whether the owner's Thread is deleted. */
const tombstoneOf = `EXISTS (
  SELECT 1 FROM threads
   WHERE id = ?1 AND owner_user_id = ?2 AND lifecycle_state = 'deleted'
)`;

/**
 * Turns the owner's live Thread into a tombstone in one D1 transaction. The
 * row stays, so its ID can never be issued again. Its title, instructions,
 * and snapshots are scrubbed. Its child Threads become top-level Threads.
 * Its notifications, sidebar placement, sharing records, and who saw it
 * are removed, and the deletion is recorded for cleanup. Returns false when the Thread was
 * not live (already deleted, or not the owner's).
 */
export const tombstoneThread = async (
  db: D1Database,
  threadId: ThreadId,
  ownerUserId: UserId,
  deletedAt: string,
): Promise<boolean> => {
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
          WHERE id = ?1 AND owner_user_id = ?2
            AND lifecycle_state != 'deleted'`,
      )
      .bind(threadId, ownerUserId, DELETED_THREAD_TITLE, deletedAt),
    db
      .prepare(
        `INSERT INTO thread_deletion (thread_id, owner_user_id, requested_at)
         SELECT ?1, ?2, ?3 WHERE ${tombstoneOf}
         ON CONFLICT (thread_id) DO NOTHING`,
      )
      .bind(threadId, ownerUserId, deletedAt),
    db
      .prepare(
        `UPDATE threads SET parent_thread_id = NULL
          WHERE parent_thread_id = ?1 AND ${tombstoneOf}`,
      )
      .bind(threadId, ownerUserId),
    db
      .prepare(
        `DELETE FROM notification WHERE thread_id = ?1 AND ${tombstoneOf}`,
      )
      .bind(threadId, ownerUserId),
    db
      .prepare(
        `DELETE FROM sidebar_layout_entry
          WHERE kind = 'thread' AND item_id = ?1 AND ${tombstoneOf}`,
      )
      .bind(threadId, ownerUserId),
    db
      .prepare(
        `DELETE FROM thread_participant WHERE thread_id = ?1 AND ${tombstoneOf}`,
      )
      .bind(threadId, ownerUserId),
    db
      .prepare(
        `DELETE FROM thread_follower WHERE thread_id = ?1 AND ${tombstoneOf}`,
      )
      .bind(threadId, ownerUserId),
    db
      .prepare(
        `DELETE FROM thread_seen WHERE thread_id = ?1 AND ${tombstoneOf}`,
      )
      .bind(threadId, ownerUserId),
  ]);
  return (tombstoned?.meta.changes ?? 0) > 0;
};

/** The child Threads a deletion turns into top-level Threads. */
export const childThreadIds = async (db: D1Database, threadId: ThreadId) =>
  (
    await db
      .prepare(
        "SELECT id FROM threads WHERE parent_thread_id = ? AND lifecycle_state != 'deleted'",
      )
      .bind(threadId)
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
