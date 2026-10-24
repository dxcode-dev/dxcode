import type { ThreadChildActivity } from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";

/**
 * SQL over a `threads` row aliased `thread`: the agent finished a turn after
 * the user bound to `viewer` last saw the Thread.
 */
export const threadUnreadSql = (thread: string, viewer: string) =>
  `(${thread}.turn_settled_at IS NOT NULL
    AND ${thread}.turn_settled_at > COALESCE(
      (SELECT seen.seen_at FROM thread_seen AS seen
        WHERE seen.thread_id = ${thread}.id AND seen.user_id = ${viewer}),
      ''))`;

/** What a sidebar row draws attention to, as the list item carries it. */
export const threadAttentionFields = (row: {
  readonly unread: number | null;
  readonly turn_failed: number | null;
}) => ({
  ...(row.unread === 1 ? { unread: true as const } : {}),
  ...(row.turn_failed === 1 ? { turnFailed: true as const } : {}),
});

/**
 * Records that these people saw the Thread at `seenAt`. A later sighting
 * already recorded stands.
 */
export const markThreadSeen = async (
  db: D1Database,
  threadId: ThreadId,
  userIds: ReadonlyArray<UserId | string>,
  seenAt: string,
) => {
  if (userIds.length === 0) return;
  await db.batch(
    userIds.map((userId) =>
      db
        .prepare(
          `INSERT INTO thread_seen (thread_id, user_id, seen_at)
           SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM threads WHERE id = ?1)
           ON CONFLICT (thread_id, user_id) DO UPDATE SET
             seen_at = MAX(thread_seen.seen_at, excluded.seen_at)`,
        )
        .bind(threadId, userId, seenAt),
    ),
  );
};

/**
 * The user opened the Thread: records it seen when it was unread for them.
 * True when it was, so their other clients have a row to refresh.
 */
export const markThreadOpened = async (
  db: D1Database,
  threadId: ThreadId,
  userId: UserId | string,
  seenAt: string,
) => {
  const result = await db
    .prepare(
      `INSERT INTO thread_seen (thread_id, user_id, seen_at)
       SELECT thread.id, ?2, ?3 FROM threads AS thread
        WHERE thread.id = ?1 AND ${threadUnreadSql("thread", "?2")}
       ON CONFLICT (thread_id, user_id) DO UPDATE SET
         seen_at = MAX(thread_seen.seen_at, excluded.seen_at)`,
    )
    .bind(threadId, userId, seenAt)
    .run();
  return result.meta.changes > 0;
};

/** The child-count columns a parent's row aggregates, for `viewer`. */
export const childActivityColumnsSql = (viewer: string) =>
  `COUNT(*) AS child_count,
   SUM(child.activity_status = 'working') AS child_working,
   SUM(${threadUnreadSql("child", viewer)}) AS child_unread,
   SUM(child.turn_failed = 1) AS child_failed`;

export interface ChildActivityRow {
  readonly child_count: number;
  readonly child_working: number | null;
  readonly child_unread: number | null;
  readonly child_failed: number | null;
}

/** A parent's `childActivity`, absent while nothing calls for it. */
export const childActivityField = (activity: ThreadChildActivity) =>
  activity.working + activity.unread + activity.failed === 0
    ? {}
    : { childActivity: activity };

export const childActivityFrom = (
  row: ChildActivityRow,
): ThreadChildActivity => ({
  working: row.child_working ?? 0,
  unread: row.child_unread ?? 0,
  failed: row.child_failed ?? 0,
});
