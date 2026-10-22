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
  type UserId,
} from "@dx/domain";
import { Effect, Schema } from "effect";
import { activeMemberSql } from "../settings/members/membership-sql.js";
import {
  sharedThreadAccessSql,
  sharedThreadVisibleSql,
} from "../thread-sharing/access.js";
import {
  decorateSharingRows,
  type SharingRow,
} from "../thread-sharing/service.js";
import { decodeThreadRows } from "./repository-d1.js";
import { threadSnoozeData } from "./snooze.js";

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
  ...threadSnoozeData(thread),
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
  // D1 binds at most 100 parameters per statement.
  const results = await Promise.all(
    Array.from({ length: Math.ceil(threadIds.length / 100) }, (_, index) => {
      const ids = threadIds.slice(index * 100, index * 100 + 100);
      return db
        .prepare(
          `SELECT thread_id, latest_capture_id, dirty_since,
                  summary_additions, summary_deletions, summary_files
             FROM thread_changes_state
            WHERE thread_id IN (${ids.map(() => "?").join(", ")})`,
        )
        .bind(...ids)
        .all();
    }),
  );
  const rows = Schema.decodeUnknownSync(Schema.Array(SummaryRowSchema))(
    results.flatMap((result) => result.results),
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
 * SQL predicate over `child`, its `parent`, and `child_project`: the child
 * lists under its parent, as the children list returns it.
 */
const listedUnderParentSql = `child.owner_user_id = parent.owner_user_id
          AND child.lifecycle_state = parent.lifecycle_state
          AND child.pinned_at IS NULL
          AND (child_project.workspace_id IS NULL
            OR ${activeMemberSql("child_project.workspace_id", "child.owner_user_id")})`;

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
          AND ${listedUnderParentSql}
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
 * One Thread's row as the requester's sidebar lists it, in one statement (two
 * when the Thread is shared): the owner's row as the Thread lists return it,
 * or, for a member following another member's shared Thread, its row in the
 * shared list. `childCount` is present when children list under it, as a
 * roots list counts them. Undefined when neither list could hold it.
 */
export const readThreadListItem = async (
  db: D1Database,
  threadId: ThreadId,
  requester: { readonly userId: UserId; readonly sharedThreads: boolean },
  now = new Date(),
): Promise<ThreadListItem | undefined> => {
  const row = await db
    .prepare(
      `SELECT thread.id, thread.title, thread.project_id, thread.owner_user_id,
              thread.agent_instructions, thread.agent_instructions_revision,
              thread.agent_instructions_version, thread.model_selection,
              thread.runner_profile_id, thread.title_pending_until, thread.color,
              thread.parent_thread_id,
              thread.plugin_snapshot_json, thread.skill_snapshot_json,
              thread.visibility, thread.created_at, thread.updated_at,
              COALESCE(thread.last_activity_at, thread.updated_at) AS last_activity_at,
              thread.activity_status, thread.lifecycle_state,
              CASE WHEN thread.owner_user_id = ?2 THEN thread.pinned_at END AS pinned_at,
              CASE WHEN thread.owner_user_id = ?2 THEN thread.snoozed_until END AS snoozed_until,
              CASE WHEN thread.owner_user_id = ?2 THEN thread.snooze_woke_at END AS snooze_woke_at,
              thread.workspace_access, thread.contribute_until,
              thread.owner_user_id = ?2 AS owned,
              ${sharedThreadAccessSql("thread", "?3")} AS access,
              project.name AS project_name,
              summary.latest_capture_id, summary.dirty_since,
              summary.summary_additions, summary.summary_deletions,
              summary.summary_files,
              (SELECT parent.color FROM threads AS parent
                WHERE parent.id = thread.parent_thread_id) AS parent_color,
              (SELECT COUNT(*) FROM threads AS child
                 JOIN threads AS parent ON parent.id = child.parent_thread_id
                 JOIN projects AS child_project ON child_project.id = child.project_id
                WHERE child.parent_thread_id = thread.id
                  AND ${listedUnderParentSql}) AS child_count
         FROM threads AS thread
         JOIN projects AS project ON project.id = thread.project_id
         LEFT JOIN thread_changes_state AS summary ON summary.thread_id = thread.id
        WHERE thread.id = ?1
          AND thread.lifecycle_state != 'deleted'
          AND ((thread.owner_user_id = ?2
                AND (project.workspace_id IS NULL
                  OR ${activeMemberSql("project.workspace_id", "?2")}))
            OR (?4 = 1
                AND thread.lifecycle_state = 'active'
                AND EXISTS (SELECT 1 FROM thread_follower AS follower
                             WHERE follower.thread_id = thread.id
                               AND follower.user_id = ?2)
                AND ${sharedThreadVisibleSql("thread", "project", "?2")}))`,
    )
    .bind(
      threadId,
      requester.userId,
      now.toISOString(),
      requester.sharedThreads ? 1 : 0,
    )
    .first<
      Record<string, unknown> &
        SharingRow &
        typeof SummaryRowSchema.Encoded & {
          readonly owned: number;
          readonly access: "contribute" | "view";
          readonly project_name: string;
          readonly parent_color: ThreadColor | null;
          readonly child_count: number;
        }
    >();
  if (row === null) return undefined;
  const [thread] = await Effect.runPromise(decodeThreadRows([row]));
  if (thread === undefined) return undefined;
  const decoration = (await decorateSharingRows(db, [row], { now })).get(
    thread.id,
  );
  // As the shared list returns it: no totals, pin, or tree decoration.
  if (row.owned !== 1)
    return {
      ...threadListItem(thread),
      access: row.access,
      projectName: row.project_name.slice(0, 256),
      ...decoration,
    };
  return {
    ...threadListItem(
      thread,
      summaryFrom(
        Schema.decodeUnknownSync(SummaryRowSchema)({
          ...row,
          thread_id: row.id,
        }),
      ),
    ),
    ...decoration,
    ...(row.child_count > 0 ? { childCount: row.child_count } : {}),
    ...(row.parent_color === null ? {} : { parentColor: row.parent_color }),
  };
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
