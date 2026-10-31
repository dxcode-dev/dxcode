import {
  type ThreadChangesSummary,
  type ThreadChildActivity,
  type ThreadListItem,
  threadAgentUrl,
} from "@dx/api";
import {
  isThreadTitlePending,
  PROJECTLESS_PROJECT_NAME,
  type Thread,
  type ThreadColor,
  type ThreadId,
  type UserId,
} from "@dx/domain";
import { Effect, Schema } from "effect";
import {
  activeMemberSql,
  threadProjectReachableSql,
} from "../settings/members/membership-sql.js";
import {
  sharedThreadAccessSql,
  sharedThreadVisibleSql,
} from "../thread-sharing/access.js";
import {
  decorateSharingRows,
  type SharingRow,
} from "../thread-sharing/service.js";
import {
  type ChildActivityRow,
  childActivityColumnsSql,
  childActivityField,
  childActivityFrom,
  threadAttentionFields,
  threadUnreadSql,
} from "./attention-d1.js";
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

/**
 * SQL over `project`: the Project is its owner's hidden No Project. The name
 * is inlined because a list statement already binds 100 Thread IDs, D1's
 * limit; no named Project can take it, since names allow no spaces.
 */
const projectlessSql = `project.name = '${PROJECTLESS_PROJECT_NAME}'`;

/** The list item's marker for a Thread in its owner's hidden No Project. */
export const projectlessField = (projectName: string | undefined) =>
  projectName === PROJECTLESS_PROJECT_NAME
    ? { projectless: true as const }
    : {};

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
  ...(thread.startedByThreadId === undefined
    ? {}
    : { startedByThreadId: thread.startedByThreadId }),
  mode:
    thread.selection.kind === "mode"
      ? thread.selection.mode
      : thread.selection.model,
  changes,
});

/**
 * Each owned Thread's Changes totals, what its row draws attention to, and
 * whether it is in its owner's hidden No Project, for its owner: these lists
 * hold only the requester's own Threads.
 */
export const readThreadListProjection = async (
  db: D1Database,
  threadIds: readonly ThreadId[],
) => {
  const changes = new Map<ThreadId, ThreadChangesSummary>();
  const attention = new Map<
    ThreadId,
    ReturnType<typeof threadAttentionFields>
  >();
  const projectless = new Map<ThreadId, { readonly projectless: true }>();
  // D1 binds at most 100 parameters per statement.
  const results = await Promise.all(
    Array.from({ length: Math.ceil(threadIds.length / 100) }, (_, index) => {
      const ids = threadIds.slice(index * 100, index * 100 + 100);
      return db
        .prepare(
          `SELECT thread.id AS thread_id, summary.latest_capture_id,
                  summary.dirty_since, summary.summary_additions,
                  summary.summary_deletions, summary.summary_files,
                  thread.turn_failed,
                  ${threadUnreadSql("thread", "thread.owner_user_id")} AS unread,
                  ${projectlessSql} AS projectless
             FROM threads AS thread
             JOIN projects AS project ON project.id = thread.project_id
             LEFT JOIN thread_changes_state AS summary
               ON summary.thread_id = thread.id
            WHERE thread.id IN (${ids.map(() => "?").join(", ")})
              AND (summary.thread_id IS NOT NULL OR thread.turn_failed = 1
                OR thread.turn_settled_at IS NOT NULL OR ${projectlessSql})`,
        )
        .bind(...ids)
        .all();
    }),
  );
  const rows = Schema.decodeUnknownSync(
    Schema.Array(
      Schema.Struct({
        ...SummaryRowSchema.fields,
        turn_failed: Schema.Number,
        unread: Schema.Number,
        projectless: Schema.Number,
      }),
    ),
  )(results.flatMap((result) => result.results));
  for (const row of rows) {
    const id = row.thread_id as ThreadId;
    const summary = summaryFrom(row);
    if (summary !== undefined) changes.set(id, summary);
    const marks = threadAttentionFields(row);
    if (Object.keys(marks).length > 0) attention.set(id, marks);
    if (row.projectless === 1) projectless.set(id, { projectless: true });
  }
  return { changes, attention, projectless };
};

/**
 * SQL predicate over `child`, its `parent`, and `child_project`: the child
 * lists under its parent, as the children list returns it.
 */
export const listedUnderParentSql = `child.owner_user_id = parent.owner_user_id
          AND child.lifecycle_state = parent.lifecycle_state
          AND child.pinned_at IS NULL
          AND (child_project.workspace_id IS NULL
            OR child_project.deleted_at IS NOT NULL
            OR ${activeMemberSql("child_project.workspace_id", "child.owner_user_id")})`;

/**
 * A recursive CTE `started_below(top, id)`: for each child Thread whose id
 * `anchor` (SQL over `starter.id`) selects, every Thread below it that the
 * sidebar does not list under the root, as `listedUnderRootSql` decides.
 */
const startedBelowCteSql = (anchor: string) => {
  const hidden = `started.parent_thread_id = starter.parent_thread_id
          AND starter.parent_thread_id IS NOT NULL
          AND started.owner_user_id = starter.owner_user_id
          AND started.lifecycle_state = starter.lifecycle_state
          AND starter.pinned_at IS NULL
          AND started.pinned_at IS NULL
          AND (started_project.workspace_id IS NULL
            OR ${activeMemberSql("started_project.workspace_id", "started.owner_user_id")})`;
  return `started_below(top, id) AS (
      SELECT starter.id, started.id
        FROM threads AS starter
        JOIN threads AS started ON started.started_by_thread_id = starter.id
        JOIN projects AS started_project ON started_project.id = started.project_id
       WHERE ${anchor} AND ${hidden}
      UNION
      SELECT started_below.top, started.id
        FROM started_below
        JOIN threads AS starter ON starter.id = started_below.id
        JOIN threads AS started ON started.started_by_thread_id = starter.id
        JOIN projects AS started_project ON started_project.id = started.project_id
       WHERE ${hidden})`;
};

/**
 * How many Threads sit below each of these child Threads without listing
 * in the sidebar: those it started, and theirs. Threads with none are
 * absent.
 */
export const readThreadStartedCounts = async (
  db: D1Database,
  threadIds: readonly ThreadId[],
) => {
  const counts = new Map<ThreadId, number>();
  // D1 binds at most 100 parameters per statement.
  const results = await Promise.all(
    Array.from({ length: Math.ceil(threadIds.length / 100) }, (_, index) => {
      const ids = threadIds.slice(index * 100, index * 100 + 100);
      return db
        .prepare(
          `WITH RECURSIVE ${startedBelowCteSql(
            `starter.id IN (${ids.map(() => "?").join(", ")})`,
          )}
           SELECT top, COUNT(*) AS started_count
             FROM started_below GROUP BY top`,
        )
        .bind(...ids)
        .all<{ top: ThreadId; started_count: number }>();
    }),
  );
  for (const result of results)
    for (const row of result.results) counts.set(row.top, row.started_count);
  return counts;
};

/** The list item field for a child Thread's count; absent when zero. */
export const startedCountField = (count: number | undefined) =>
  count === undefined || count === 0 ? {} : { startedCount: count };

/**
 * How many child Threads list under each root: unpinned children that
 * share their parent's lifecycle state, in projects their owner still
 * reaches (as the Thread repository's reachable scope decides), as the
 * children list returns them; and how many of those work, are unread for
 * their owner, and ended their latest turn in an error. Roots without
 * children are absent.
 */
export const readThreadChildCounts = async (
  db: D1Database,
  threadIds: readonly ThreadId[],
) => {
  if (threadIds.length === 0)
    return new Map<
      ThreadId,
      { count: number; activity: ThreadChildActivity }
    >();
  const placeholders = threadIds.map(() => "?").join(", ");
  const result = await db
    .prepare(
      `SELECT child.parent_thread_id AS parent_thread_id,
              ${childActivityColumnsSql("child.owner_user_id")}
         FROM threads AS child
         JOIN threads AS parent ON parent.id = child.parent_thread_id
         JOIN projects AS child_project ON child_project.id = child.project_id
        WHERE child.parent_thread_id IN (${placeholders})
          AND ${listedUnderParentSql}
        GROUP BY child.parent_thread_id`,
    )
    .bind(...threadIds)
    .all<ChildActivityRow & { parent_thread_id: ThreadId }>();
  return new Map(
    result.results.map((row) => [
      row.parent_thread_id,
      { count: row.child_count, activity: childActivityFrom(row) },
    ]),
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
      `WITH RECURSIVE ${startedBelowCteSql("starter.id = ?1 AND starter.owner_user_id = ?2")}
       SELECT thread.id, thread.title, thread.project_id, thread.owner_user_id,
              thread.agent_instructions, thread.agent_instructions_revision,
              thread.agent_instructions_version, thread.model_selection,
              thread.runner_profile_id, thread.title_pending_until, thread.color,
              thread.parent_thread_id, thread.started_by_thread_id,
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
              thread.turn_failed, ${threadUnreadSql("thread", "?2")} AS unread,
              COALESCE(family.child_count, 0) AS child_count,
              (SELECT COUNT(*) FROM started_below) AS started_count,
              family.child_working, family.child_unread, family.child_failed
         FROM threads AS thread
         JOIN projects AS project ON project.id = thread.project_id
         LEFT JOIN thread_changes_state AS summary ON summary.thread_id = thread.id
         LEFT JOIN (
           SELECT child.parent_thread_id, ${childActivityColumnsSql("?2")}
             FROM threads AS child
             JOIN threads AS parent ON parent.id = child.parent_thread_id
             JOIN projects AS child_project ON child_project.id = child.project_id
            WHERE child.parent_thread_id = ?1
              AND ${listedUnderParentSql}
            GROUP BY child.parent_thread_id
         ) AS family ON family.parent_thread_id = thread.id
        WHERE thread.id = ?1
          AND thread.lifecycle_state != 'deleted'
          AND ((thread.owner_user_id = ?2
                AND (project.workspace_id IS NULL
                  OR project.deleted_at IS NOT NULL
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
          readonly turn_failed: number;
          readonly unread: number;
          readonly started_count: number;
        } & ChildActivityRow
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
      ...projectlessField(row.project_name),
      ...decoration,
      ...threadAttentionFields(row),
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
    ...projectlessField(row.project_name),
    ...decoration,
    ...threadAttentionFields(row),
    ...(row.child_count > 0
      ? {
          childCount: row.child_count,
          ...childActivityField(childActivityFrom(row)),
        }
      : {}),
    ...(row.parent_color === null ? {} : { parentColor: row.parent_color }),
    ...startedCountField(row.started_count),
  };
};

/**
 * SQL predicate over `thread` and its `project`: the requester bound to `?2`
 * may read the Thread. The owner reads it in a Project they still reach, or,
 * through an External API App held to the workspace bound to `?5`, only in
 * that workspace's Projects. A member reads it while it is shared with them
 * and `?4` is 1.
 */
const readableThreadSql = `(
  (thread.owner_user_id = ?2
    AND ((?5 IS NULL AND ${threadProjectReachableSql("project", "?2")})
      OR (?5 IS NOT NULL AND project.workspace_id = ?5
        AND ${activeMemberSql("project.workspace_id", "?2")})))
  OR (?4 = 1 AND ${sharedThreadVisibleSql("thread", "project", "?2")}))`;

/**
 * The family of `threadId` as the requester may read it: its root and the
 * root's active children, oldest first, up to `limit`. The root and
 * `threadId` itself list even when archived, so an archived root still heads
 * its active children; a child whose starter is archived names it anyway,
 * and the tree page lists it under the root. A member
 * of a shared family gets only the members shared with them, without the
 * owner's pins or snoozes. Undefined when the requester cannot read the
 * Thread itself.
 */
export const readThreadFamily = async (
  db: D1Database,
  threadId: ThreadId,
  requester: {
    readonly userId: UserId;
    /** An External API App's workspace, which holds it to its Projects. */
    readonly workspaceId?: string;
    readonly sharedThreads: boolean;
  },
  limit: number,
  now = new Date(),
): Promise<
  | {
      readonly rootThreadId: ThreadId;
      readonly items: ReadonlyArray<ThreadListItem>;
      readonly truncated: boolean;
    }
  | undefined
> => {
  const rows = (
    await db
      .prepare(
        `WITH target AS (
           SELECT COALESCE(thread.parent_thread_id, thread.id) AS root_id,
                  thread.owner_user_id
             FROM threads AS thread
             JOIN projects AS project ON project.id = thread.project_id
            WHERE thread.id = ?1
              AND thread.lifecycle_state != 'deleted'
              AND ${readableThreadSql}
         )
         SELECT target.root_id,
                thread.id, thread.title, thread.project_id, thread.owner_user_id,
                thread.agent_instructions, thread.agent_instructions_revision,
                thread.agent_instructions_version, thread.model_selection,
                thread.runner_profile_id, thread.title_pending_until, thread.color,
                thread.parent_thread_id, thread.started_by_thread_id,
                thread.plugin_snapshot_json, thread.skill_snapshot_json,
                thread.visibility, thread.created_at, thread.updated_at,
                COALESCE(thread.last_activity_at, thread.updated_at) AS last_activity_at,
                thread.activity_status, thread.lifecycle_state,
                CASE WHEN thread.owner_user_id = ?2 THEN thread.pinned_at END AS pinned_at,
                CASE WHEN thread.owner_user_id = ?2 THEN thread.snoozed_until END AS snoozed_until,
                CASE WHEN thread.owner_user_id = ?2 THEN thread.snoozed_at END AS snoozed_at,
                CASE WHEN thread.owner_user_id = ?2 THEN thread.snooze_woke_at END AS snooze_woke_at,
                thread.owner_user_id = ?2 AS owned,
                ${sharedThreadAccessSql("thread", "?3")} AS access,
                project.name AS project_name,
                thread.turn_failed, ${threadUnreadSql("thread", "?2")} AS unread
           FROM target
           JOIN threads AS thread
             ON thread.id = target.root_id OR thread.parent_thread_id = target.root_id
           JOIN projects AS project ON project.id = thread.project_id
          WHERE thread.owner_user_id = target.owner_user_id
            AND (thread.lifecycle_state = 'active'
              OR (thread.lifecycle_state = 'archived'
                AND (thread.id = target.root_id OR thread.id = ?1)))
            AND ${readableThreadSql}
          ORDER BY thread.created_at, thread.id
          LIMIT ?6`,
      )
      .bind(
        threadId,
        requester.userId,
        now.toISOString(),
        requester.sharedThreads ? 1 : 0,
        requester.workspaceId ?? null,
        limit + 1,
      )
      .all<
        Record<string, unknown> & {
          readonly root_id: ThreadId;
          readonly owned: number;
          readonly access: "contribute" | "view";
          readonly project_name: string;
          readonly turn_failed: number;
          readonly unread: number;
        }
      >()
  ).results;
  const rootThreadId = rows[0]?.root_id;
  if (rootThreadId === undefined) return undefined;
  const listed = rows.slice(0, limit);
  const threads = await Effect.runPromise(decodeThreadRows(listed));
  return {
    rootThreadId,
    items: threads.flatMap((thread, index) => {
      const row = listed[index];
      if (row === undefined) return [];
      return [
        {
          ...threadListItem(thread),
          ...threadAttentionFields(row),
          // As the shared list returns another member's Thread.
          ...(row.owned === 1
            ? {}
            : {
                access: row.access,
                projectName: row.project_name.slice(0, 256),
              }),
        },
      ];
    }),
    truncated: rows.length > limit,
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
