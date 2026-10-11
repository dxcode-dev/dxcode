import {
  type ThreadChangesSummary,
  type ThreadListItem,
  threadAgentUrl,
} from "@dx/api";
import {
  isThreadTitlePending,
  type Thread,
  type ThreadColor,
  type ThreadId,
} from "@dx/domain";
import { Schema } from "effect";
import { activeMemberSql } from "../settings/members/membership-sql.js";

const SummaryRowSchema = Schema.Struct({
  thread_id: Schema.String,
  latest_capture_id: Schema.NullOr(Schema.String),
  dirty_since: Schema.NullOr(Schema.String),
  summary_additions: Schema.NullOr(Schema.Number),
  summary_deletions: Schema.NullOr(Schema.Number),
  summary_files: Schema.NullOr(Schema.Number),
});

const summaryFrom = (row: typeof SummaryRowSchema.Type) =>
  row.latest_capture_id !== null &&
  row.dirty_since === null &&
  row.summary_additions !== null &&
  row.summary_deletions !== null &&
  row.summary_files !== null
    ? {
        additions: row.summary_additions,
        deletions: row.summary_deletions,
        files: row.summary_files,
      }
    : undefined;

export const threadListItem = (
  thread: Thread,
  changes?: ThreadChangesSummary,
): ThreadListItem => ({
  id: thread.id,
  title: thread.title,
  projectId: thread.projectId,
  visibility: thread.visibility ?? "private",
  createdAt: thread.createdAt,
  updatedAt: thread.updatedAt,
  lastActivityAt: thread.lastActivityAt,
  activityStatus: thread.activityStatus,
  lifecycleState: thread.lifecycleState,
  pinnedAt: thread.pinnedAt,
  ...(thread.color === undefined ? {} : { color: thread.color }),
  ...(isThreadTitlePending(thread) ? { titlePending: true } : {}),
  agentUrl: threadAgentUrl(thread.id),
  ...(thread.parentThreadId === undefined
    ? {}
    : { parentThreadId: thread.parentThreadId }),
  mode:
    thread.selection.kind === "mode"
      ? thread.selection.mode
      : thread.selection.model,
  changes,
});

export const readThreadListProjection = async (
  db: D1Database,
  threadIds: readonly ThreadId[],
) => {
  if (threadIds.length === 0) return new Map<ThreadId, ThreadChangesSummary>();
  const placeholders = threadIds.map(() => "?").join(", ");
  const result = await db
    .prepare(
      `SELECT thread_id, latest_capture_id, dirty_since,
              summary_additions, summary_deletions, summary_files
         FROM thread_changes_state
        WHERE thread_id IN (${placeholders})`,
    )
    .bind(...threadIds)
    .all();
  const rows = Schema.decodeUnknownSync(Schema.Array(SummaryRowSchema))(
    result.results,
  );
  return new Map(
    rows.flatMap((row) => {
      const summary = summaryFrom(row);
      return summary === undefined
        ? []
        : [[row.thread_id as ThreadId, summary] as const];
    }),
  );
};

/**
 * How many child Threads list under each root: unpinned children that
 * share their parent's lifecycle state, in projects their owner still
 * reaches (as the Thread repository's reachable scope decides), as the
 * children list returns them. Roots without children are
 * absent.
 */
export const readThreadChildCounts = async (
  db: D1Database,
  threadIds: readonly ThreadId[],
) => {
  if (threadIds.length === 0) return new Map<ThreadId, number>();
  const placeholders = threadIds.map(() => "?").join(", ");
  const result = await db
    .prepare(
      `SELECT child.parent_thread_id AS parent_thread_id,
              COUNT(*) AS child_count
         FROM threads AS child
         JOIN threads AS parent ON parent.id = child.parent_thread_id
         JOIN projects AS child_project ON child_project.id = child.project_id
        WHERE child.parent_thread_id IN (${placeholders})
          AND child.owner_user_id = parent.owner_user_id
          AND child.lifecycle_state = parent.lifecycle_state
          AND child.pinned_at IS NULL
          AND (child_project.workspace_id IS NULL
            OR ${activeMemberSql("child_project.workspace_id", "child.owner_user_id")})
        GROUP BY child.parent_thread_id`,
    )
    .bind(...threadIds)
    .all<{ parent_thread_id: ThreadId; child_count: number }>();
  return new Map(
    result.results.map((row) => [row.parent_thread_id, row.child_count]),
  );
};

/** The chosen color of each listed parent; parents on auto are absent. */
export const readParentColors = async (
  db: D1Database,
  parentThreadIds: readonly ThreadId[],
) => {
  const ids = [...new Set(parentThreadIds)];
  if (ids.length === 0) return new Map<ThreadId, ThreadColor>();
  const result = await db
    .prepare(
      `SELECT id, color FROM threads
        WHERE id IN (${ids.map(() => "?").join(", ")}) AND color IS NOT NULL`,
    )
    .bind(...ids)
    .all<{ id: ThreadId; color: ThreadColor }>();
  return new Map(result.results.map(({ id, color }) => [id, color]));
};

/**
 * Submissions other Threads' agents sent while this Thread worked that have
 * not settled, from the last 30 minutes. Clients drop each once Flue's
 * history holds it.
 */
export const readInboundMessages = async (db: D1Database, threadId: ThreadId) =>
  (
    await db
      .prepare(
        `SELECT submission_id AS submissionId,
                source_thread_id AS sourceThreadId,
                observed_at AS createdAt
           FROM thread_activity_submission
          WHERE thread_id = ? AND source_thread_id IS NOT NULL
            AND state = 'working' AND observed_at >= ?
          ORDER BY observed_at
          LIMIT 50`,
      )
      .bind(threadId, new Date(Date.now() - 30 * 60_000).toISOString())
      .all<{
        submissionId: string;
        sourceThreadId: ThreadId;
        createdAt: string;
      }>()
  ).results;
