import type { UserId } from "@dx/domain";
import { threadProjectReachableSql } from "../settings/members/membership-sql.js";
import { sharedThreadVisibleSql } from "../thread-sharing/access.js";

/**
 * SQL predicate: `user` may read the Thread aliased `thread` (Project
 * `project`), as Thread authorization decides: its owner while they still
 * reach its Project, or a member it is shared with. `user` is a trusted SQL
 * expression.
 */
const readableSql = (user: string, shared: boolean) => `(
  thread.lifecycle_state != 'deleted'
  AND ((thread.owner_user_id = ${user}
        AND ${threadProjectReachableSql("project", user)})
    ${shared ? `OR ${sharedThreadVisibleSql("thread", "project", user)}` : ""}))`;

/** Whether the person may read the Thread, so its draft is theirs to use. */
export const threadDraftReadable = async (
  db: D1Database,
  threadId: string,
  userId: UserId,
  { shared }: { readonly shared: boolean },
) =>
  (await db
    .prepare(
      `SELECT 1 AS readable FROM threads AS thread
         JOIN projects AS project ON project.id = thread.project_id
        WHERE thread.id = ?1 AND ${readableSql("?2", shared)}`,
    )
    .bind(threadId, userId)
    .first()) !== null;

/** The person's unsent message in the Thread's composer; "" when none. */
export const readThreadDraft = async (
  db: D1Database,
  threadId: string,
  userId: UserId,
): Promise<string> => {
  const row = await db
    .prepare(
      `SELECT text FROM thread_draft WHERE thread_id = ?1 AND user_id = ?2`,
    )
    .bind(threadId, userId)
    .first<{ text: string }>();
  return row?.text ?? "";
};

/** Replaces the person's draft; the last write wins. "" deletes it. */
export const writeThreadDraft = async (
  db: D1Database,
  threadId: string,
  userId: UserId,
  text: string,
  now = new Date(),
) => {
  if (text === "") {
    await db
      .prepare(`DELETE FROM thread_draft WHERE thread_id = ?1 AND user_id = ?2`)
      .bind(threadId, userId)
      .run();
    return;
  }
  await db
    .prepare(
      `INSERT INTO thread_draft (thread_id, user_id, text, updated_at)
       SELECT ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM threads WHERE id = ?1)
       ON CONFLICT (thread_id, user_id) DO UPDATE SET
         text = excluded.text,
         updated_at = excluded.updated_at`,
    )
    .bind(threadId, userId, text, now.toISOString())
    .run();
};

/**
 * Deletes every draft whose person can no longer read its Thread: the Thread
 * was deleted, it stopped being shared with them, they or its owner left the
 * workspace, or the workspace or Project went. A draft holds whatever the
 * person typed, so it must not outlive their access. Run it in the same batch
 * as, and after, any change that takes access away.
 */
export const pruneUnreadableThreadDrafts = (db: D1Database) =>
  db.prepare(
    `DELETE FROM thread_draft
      WHERE NOT EXISTS (
        SELECT 1 FROM threads AS thread
          JOIN projects AS project ON project.id = thread.project_id
         WHERE thread.id = thread_draft.thread_id
           AND ${readableSql("thread_draft.user_id", true)})`,
  );
