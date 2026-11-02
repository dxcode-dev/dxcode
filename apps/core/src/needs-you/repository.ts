import type { NeedsYouItem, NeedsYouKind, NeedsYouLink } from "@dx/api";
import {
  PROJECTLESS_PROJECT_NAME,
  type ThreadId,
  type UserId,
} from "@dx/domain";
import { threadProjectReachableSql } from "../settings/members/membership-sql.js";

/** The longest Needs-you list returned. */
const LIST_LIMIT = 100;
/** The most issue and pull request links listed per Thread. */
const LINK_LIMIT = 5;

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
  const links = await threadLinksOf(
    db,
    rows.results.map((row) => row.thread_id),
  );
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
    ...(links.has(row.thread_id) ? { links: links.get(row.thread_id) } : {}),
  }));
};

const subjectOf = (
  json: string | null,
): { readonly title?: unknown; readonly state?: unknown } => {
  if (json === null) return {};
  try {
    const value: unknown = JSON.parse(json);
    return typeof value === "object" && value !== null ? value : {};
  } catch {
    return {};
  }
};

/**
 * The issues and pull requests each listed Thread is linked to, newest
 * first, as their webhooks last described them. The caller passes only the
 * Threads it already listed for their owner.
 */
const threadLinksOf = async (
  db: D1Database,
  threadIds: ReadonlyArray<ThreadId>,
): Promise<Map<ThreadId, ReadonlyArray<NeedsYouLink>>> => {
  const byThread = new Map<ThreadId, NeedsYouLink[]>();
  if (threadIds.length === 0) return byThread;
  const rows = await db
    .prepare(
      `SELECT thread_id, repository, number, kind, subject_json
         FROM thread_github_link
        WHERE thread_id IN (SELECT value FROM json_each(?1))
        ORDER BY created_at DESC, repository_key, number`,
    )
    .bind(JSON.stringify(threadIds))
    .all<{
      thread_id: ThreadId;
      repository: string;
      number: number;
      kind: "issue" | "pull";
      subject_json: string | null;
    }>();
  for (const row of rows.results) {
    const listed = byThread.get(row.thread_id) ?? [];
    if (listed.length >= LINK_LIMIT) continue;
    const subject = subjectOf(row.subject_json);
    const state =
      subject.state === "merged" && row.kind === "pull"
        ? "merged"
        : subject.state === "closed" || subject.state === "merged"
          ? "closed"
          : "open";
    listed.push({
      kind: row.kind,
      repository: row.repository.slice(0, 200),
      number: row.number,
      url: `https://github.com/${row.repository}/${row.kind === "pull" ? "pull" : "issues"}/${row.number}`,
      state,
      ...(typeof subject.title === "string" && subject.title !== ""
        ? { title: subject.title.slice(0, 300) }
        : {}),
    });
    byThread.set(row.thread_id, listed);
  }
  return byThread;
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
