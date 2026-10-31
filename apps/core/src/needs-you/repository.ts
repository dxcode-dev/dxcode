import type { NeedsYouItem, NeedsYouKind } from "@dx/api";
import {
  PROJECTLESS_PROJECT_NAME,
  type ThreadId,
  type UserId,
} from "@dx/domain";
import { threadProjectReachableSql } from "../settings/members/membership-sql.js";

/** The longest Needs-you list returned. */
const LIST_LIMIT = 100;

/**
 * Records what the Thread asks of its owner, replacing an earlier ask. The
 * Thread's next turn starting or the owner's Dismiss deletes it.
 */
export const requestAttention = (
  db: D1Database,
  threadId: string,
  request: {
    readonly kind: Exclude<NeedsYouKind, "failed">;
    readonly summary: string;
    readonly url?: string | undefined;
    readonly requestedAt: string;
  },
) =>
  db
    .prepare(
      `INSERT INTO thread_attention_request (
         thread_id, kind, summary, url, requested_at
       ) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (thread_id) DO UPDATE SET
         kind = excluded.kind, summary = excluded.summary,
         url = excluded.url, requested_at = excluded.requested_at`,
    )
    .bind(
      threadId,
      request.kind,
      request.summary,
      request.url ?? null,
      request.requestedAt,
    )
    .run();

/**
 * The person's Threads that wait on them, newest ask first: active Threads
 * they own, in Projects they still reach, and not snoozed now.
 */
export const listNeedsYou = async (
  db: D1Database,
  userId: UserId,
  now: string,
): Promise<ReadonlyArray<NeedsYouItem>> => {
  const rows = await db
    .prepare(
      `SELECT request.thread_id, thread.title, project.name AS project_name,
              request.kind, request.summary, request.url, request.requested_at
         FROM thread_attention_request AS request
         JOIN threads AS thread ON thread.id = request.thread_id
         JOIN projects AS project ON project.id = thread.project_id
        WHERE thread.owner_user_id = ?1
          AND thread.lifecycle_state = 'active'
          AND (thread.snoozed_until IS NULL OR thread.snoozed_until <= ?2)
          AND ${threadProjectReachableSql("project", "?1")}
        ORDER BY request.requested_at DESC, request.thread_id
        LIMIT ${LIST_LIMIT}`,
    )
    .bind(userId, now)
    .all<{
      thread_id: ThreadId;
      title: string;
      project_name: string;
      kind: NeedsYouKind;
      summary: string | null;
      url: string | null;
      requested_at: string;
    }>();
  return rows.results.map((row) => ({
    threadId: row.thread_id,
    threadTitle: row.title.slice(0, 256),
    projectName:
      row.project_name === PROJECTLESS_PROJECT_NAME
        ? ""
        : row.project_name.slice(0, 256),
    kind: row.kind,
    ...(row.summary === null ? {} : { summary: row.summary }),
    ...(row.url === null ? {} : { url: row.url }),
    requestedAt: row.requested_at,
  }));
};

/** The owner dismissed their Thread's ask. True when there was one. */
export const dismissNeedsYou = async (
  db: D1Database,
  userId: UserId,
  threadId: ThreadId,
) => {
  const result = await db
    .prepare(
      `DELETE FROM thread_attention_request
        WHERE thread_id = ?1
          AND EXISTS (SELECT 1 FROM threads
                       WHERE id = ?1 AND owner_user_id = ?2)`,
    )
    .bind(threadId, userId)
    .run();
  return result.meta.changes > 0;
};
