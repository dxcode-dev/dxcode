import {
  type ThreadChangesSummary,
  type ThreadListItem,
  threadAgentUrl,
} from "@dx/api";
import { isThreadTitlePending, type Thread, type ThreadId } from "@dx/domain";
import { Schema } from "effect";

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
  ...(isThreadTitlePending(thread) ? { titlePending: true } : {}),
  agentUrl: threadAgentUrl(thread.id),
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
