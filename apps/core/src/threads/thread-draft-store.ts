import type { ThreadDraftSlot, WorkspaceDraftSlot } from "@dx/api";
import type { UserId } from "@dx/domain";
import {
  activeMemberSql,
  threadProjectReachableSql,
} from "../settings/members/membership-sql.js";
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

/**
 * The most boxes one person keeps drafts in per Thread, besides its composer.
 * Writing another drops the one written longest ago.
 */
export const THREAD_SLOT_DRAFTS_PER_THREAD = 50;

/**
 * The person's unsent text in the Thread's composer, or in the box `slot`
 * names; "" when none.
 */
export const readThreadDraft = async (
  db: D1Database,
  threadId: string,
  userId: UserId,
  slot?: ThreadDraftSlot,
): Promise<string> => {
  const row = await (slot === undefined
    ? db
        .prepare(
          `SELECT text FROM thread_draft WHERE thread_id = ?1 AND user_id = ?2`,
        )
        .bind(threadId, userId)
    : db
        .prepare(
          `SELECT text FROM thread_slot_draft
            WHERE thread_id = ?1 AND user_id = ?2 AND slot = ?3`,
        )
        .bind(threadId, userId, slot)
  ).first<{ text: string }>();
  return row?.text ?? "";
};

/** Replaces the person's draft; the last write wins. "" deletes it. */
export const writeThreadDraft = async (
  db: D1Database,
  threadId: string,
  userId: UserId,
  text: string,
  now = new Date(),
  slot?: ThreadDraftSlot,
) => {
  if (slot !== undefined) {
    await writeThreadSlotDraft(db, threadId, userId, slot, text, now);
    return;
  }
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

const writeThreadSlotDraft = async (
  db: D1Database,
  threadId: string,
  userId: UserId,
  slot: ThreadDraftSlot,
  text: string,
  now: Date,
) => {
  if (text === "") {
    await db
      .prepare(
        `DELETE FROM thread_slot_draft
          WHERE thread_id = ?1 AND user_id = ?2 AND slot = ?3`,
      )
      .bind(threadId, userId, slot)
      .run();
    return;
  }
  await db.batch([
    db
      .prepare(
        `INSERT INTO thread_slot_draft
           (thread_id, user_id, slot, text, updated_at)
         SELECT ?1, ?2, ?3, ?4, ?5
          WHERE EXISTS (SELECT 1 FROM threads WHERE id = ?1)
         ON CONFLICT (thread_id, user_id, slot) DO UPDATE SET
           text = excluded.text,
           updated_at = excluded.updated_at`,
      )
      .bind(threadId, userId, slot, text, now.toISOString()),
    // Keeps this box and the newest others, so one person's drafts stay
    // bounded.
    db
      .prepare(
        `DELETE FROM thread_slot_draft
          WHERE thread_id = ?1 AND user_id = ?2 AND slot != ?3
            AND slot NOT IN (
              SELECT slot FROM thread_slot_draft
               WHERE thread_id = ?1 AND user_id = ?2 AND slot != ?3
               ORDER BY updated_at DESC, slot
               LIMIT ?4)`,
      )
      .bind(threadId, userId, slot, THREAD_SLOT_DRAFTS_PER_THREAD - 1),
  ]);
};

/**
 * Whether the person may keep drafts in `workspace`: `personal`, or a
 * workspace they actively belong to.
 */
export const workspaceDraftAllowed = async (
  db: D1Database,
  workspace: string,
  userId: UserId,
) =>
  workspace === "personal" ||
  (await db
    .prepare(`SELECT 1 AS allowed WHERE ${activeMemberSql("?1", "?2")}`)
    .bind(workspace, userId)
    .first()) !== null;

/** The person's unsent New Thread or New Space in `workspace`; "" if none. */
export const readWorkspaceDraft = async (
  db: D1Database,
  workspace: string,
  userId: UserId,
  slot: WorkspaceDraftSlot,
) =>
  (
    await db
      .prepare(
        `SELECT text FROM workspace_draft
          WHERE user_id = ?1 AND workspace_key = ?2 AND slot = ?3`,
      )
      .bind(userId, workspace, slot)
      .first<{ text: string }>()
  )?.text ?? "";

/** Replaces it; the last write wins. "" deletes it. */
export const writeWorkspaceDraft = async (
  db: D1Database,
  workspace: string,
  userId: UserId,
  slot: WorkspaceDraftSlot,
  text: string,
  now = new Date(),
) => {
  await (text === ""
    ? db
        .prepare(
          `DELETE FROM workspace_draft
            WHERE user_id = ?1 AND workspace_key = ?2 AND slot = ?3`,
        )
        .bind(userId, workspace, slot)
    : db
        .prepare(
          `INSERT INTO workspace_draft
             (user_id, workspace_key, slot, text, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT (user_id, workspace_key, slot) DO UPDATE SET
             text = excluded.text,
             updated_at = excluded.updated_at`,
        )
        .bind(userId, workspace, slot, text, now.toISOString())
  ).run();
};

/**
 * Deletes every draft whose person can no longer read its Thread or belong
 * to its workspace: the Thread was deleted, it stopped being shared with
 * them, they or its owner left the workspace, or the workspace or Project
 * went. A draft holds whatever the person typed, so it must not outlive
 * their access. Run these in the same batch as, and after, any change that
 * takes access away.
 */
export const pruneUnreadableDrafts = (db: D1Database) => [
  ...(["thread_draft", "thread_slot_draft"] as const).map((table) =>
    db.prepare(
      `DELETE FROM ${table}
        WHERE NOT EXISTS (
          SELECT 1 FROM threads AS thread
            JOIN projects AS project ON project.id = thread.project_id
           WHERE thread.id = ${table}.thread_id
             AND ${readableSql(`${table}.user_id`, true)})`,
    ),
  ),
  db.prepare(
    `DELETE FROM workspace_draft
      WHERE workspace_key != 'personal'
        AND NOT ${activeMemberSql("workspace_draft.workspace_key", "workspace_draft.user_id")}`,
  ),
];
