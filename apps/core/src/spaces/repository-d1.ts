import type { ThreadColor, ThreadId, UserId } from "@dx/domain";
import { THREAD_COLORS } from "@dx/domain";
import { userImageSql } from "../avatars/storage.js";
import { threadProjectReachableSql } from "../settings/members/membership-sql.js";
import {
  CONTRIBUTE_WITHOUT_END,
  sharedThreadAccessSql,
  sharedThreadVisibleSql,
} from "../thread-sharing/access.js";
import { displayNameSql } from "../thread-sharing/service.js";
import { threadUnreadSql } from "../threads/attention-d1.js";

/**
 * SQL predicate over `thread` and its `project`: the user bound to `user`
 * may open the Thread, as its owner or as a member it is shared with.
 */
export const spaceReadableSql = (user: string) => `(
  (thread.owner_user_id = ${user} AND ${threadProjectReachableSql("project", user)})
  OR ${sharedThreadVisibleSql("thread", "project", user)})`;

/** SQL expression: what the user bound to `user` may do in the Thread. */
const spaceAccessSql = (user: string, now: string) =>
  `CASE WHEN thread.owner_user_id = ${user} THEN 'owner'
        ELSE ${sharedThreadAccessSql("thread", now)} END`;

export interface SpaceRow {
  readonly id: ThreadId;
  readonly title: string;
  readonly color: ThreadColor | null;
  readonly project_id: string;
  readonly project_name: string;
  readonly workspace_access: "none" | "view" | "contribute";
  readonly owner_user_id: UserId;
  readonly lifecycle_state: "active" | "archived";
  readonly created_at: string;
  readonly last_activity_at: string;
  readonly goal: string | null;
  readonly access: "owner" | "contribute" | "view";
  readonly joined: number;
  /** The Space's own status (`set_thread_status`). */
  readonly status_line: string | null;
  readonly waiting_on_input: number | null;
}

export interface SpaceMemberRow {
  readonly space_thread_id: ThreadId;
  readonly user_id: UserId;
  readonly name: string | null;
  readonly handle: string | null;
  readonly image: string | null;
}

const spaceColumns = (user: string, now: string) => `
  thread.id, thread.title, thread.color, thread.project_id,
  project.name AS project_name, thread.workspace_access,
  thread.owner_user_id, thread.lifecycle_state, thread.created_at,
  COALESCE(thread.last_activity_at, thread.updated_at) AS last_activity_at,
  space.goal, ${spaceAccessSql(user, now)} AS access,
  thread.status_line, space.waiting_on_input,
  EXISTS (SELECT 1 FROM space_member AS joined
           WHERE joined.space_thread_id = thread.id
             AND joined.user_id = ${user}) AS joined`;

/** One Space the user may open, or null. */
export const readSpaceRow = (
  db: D1Database,
  threadId: ThreadId,
  userId: UserId,
  now = new Date(),
) =>
  db
    .prepare(
      `SELECT ${spaceColumns("?2", "?3")}
         FROM threads AS thread
         JOIN projects AS project ON project.id = thread.project_id
         LEFT JOIN space ON space.thread_id = thread.id
        WHERE thread.id = ?1 AND thread.kind = 'space'
          AND thread.lifecycle_state != 'deleted'
          AND ${spaceReadableSql("?2")}`,
    )
    .bind(threadId, userId, now.toISOString())
    .first<SpaceRow>();

/** The active Spaces the user created or joined, most recent first. */
export const listJoinedSpaceRows = async (
  db: D1Database,
  userId: UserId,
  now = new Date(),
) =>
  (
    await db
      .prepare(
        `SELECT ${spaceColumns("?1", "?2")}
           FROM space_member AS member
           JOIN threads AS thread ON thread.id = member.space_thread_id
           JOIN projects AS project ON project.id = thread.project_id
           LEFT JOIN space ON space.thread_id = thread.id
          WHERE member.user_id = ?1 AND thread.kind = 'space'
            AND thread.lifecycle_state = 'active'
            AND ${spaceReadableSql("?1")}
          ORDER BY COALESCE(thread.last_activity_at, thread.updated_at) DESC,
                   thread.id DESC
          LIMIT 100`,
      )
      .bind(userId, now.toISOString())
      .all<SpaceRow>()
  ).results;

const escapeLike = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Active Spaces shared with a workspace the user is in that they have not
 * joined, most recent first; `query` matches the name or goal.
 */
export const listDiscoverableSpaceRows = async (
  db: D1Database,
  userId: UserId,
  query: string | undefined,
  now = new Date(),
) => {
  const pattern =
    query === undefined || query.trim() === ""
      ? null
      : `%${escapeLike(query.trim())}%`;
  return (
    await db
      .prepare(
        `SELECT ${spaceColumns("?1", "?2")}
           FROM threads AS thread
           JOIN projects AS project ON project.id = thread.project_id
           LEFT JOIN space ON space.thread_id = thread.id
          WHERE thread.kind = 'space'
            AND thread.lifecycle_state = 'active'
            AND thread.workspace_access != 'none'
            AND ${spaceReadableSql("?1")}
            AND NOT EXISTS (SELECT 1 FROM space_member AS joined
                             WHERE joined.space_thread_id = thread.id
                               AND joined.user_id = ?1)
            AND (?3 IS NULL OR thread.title LIKE ?3 ESCAPE '\\'
                 OR space.goal LIKE ?3 ESCAPE '\\')
          ORDER BY COALESCE(thread.last_activity_at, thread.updated_at) DESC,
                   thread.id DESC
          LIMIT 100`,
      )
      .bind(userId, now.toISOString(), pattern)
      .all<SpaceRow>()
  ).results;
};

const placeholders = (count: number) =>
  Array.from({ length: count }, (_, index) => `?${index + 1}`).join(", ");

/** Each Space's members, the owner first, then by when they joined. */
export const readSpaceMembers = async (
  db: D1Database,
  threadIds: ReadonlyArray<ThreadId>,
): Promise<ReadonlyMap<ThreadId, ReadonlyArray<SpaceMemberRow>>> => {
  const members = new Map<ThreadId, SpaceMemberRow[]>();
  for (let index = 0; index < threadIds.length; index += 90) {
    const ids = threadIds.slice(index, index + 90);
    const rows = await db
      .prepare(
        `SELECT member.space_thread_id, member.user_id,
                ${displayNameSql('"user"', "account")} AS name,
                account.username AS handle,
                ${userImageSql('"user"', "account")} AS image
           FROM space_member AS member
           JOIN threads AS thread ON thread.id = member.space_thread_id
           JOIN "user" ON "user".id = member.user_id
           LEFT JOIN personal_account AS account ON account.user_id = "user".id
          WHERE member.space_thread_id IN (${placeholders(ids.length)})
          ORDER BY member.space_thread_id,
                   member.user_id = thread.owner_user_id DESC,
                   member.joined_at, member.user_id`,
      )
      .bind(...ids)
      .all<SpaceMemberRow>();
    for (const row of rows.results) {
      const list = members.get(row.space_thread_id) ?? [];
      if (list.length < 50) list.push(row);
      members.set(row.space_thread_id, list);
    }
  }
  return members;
};

/** A color for a Space created without one, stable for its ID. */
export const defaultSpaceColor = (threadId: string): ThreadColor => {
  let hash = 0;
  for (const character of threadId)
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  // Gray reads as "no color"; a Space always has one.
  const colors = THREAD_COLORS.filter((color) => color !== "gray");
  return colors[hash % colors.length] ?? "blue";
};

/** Sharing columns for a Space's family: everyone may chat, or only the owner. */
const sharingColumns = (workspaceId: string | undefined) =>
  workspaceId === undefined
    ? {
        visibility: "private",
        workspaceAccess: "none",
        sharedWorkspaceId: null,
        contributeUntil: null,
      }
    : {
        visibility: "workspace",
        workspaceAccess: "contribute",
        sharedWorkspaceId: workspaceId,
        contributeUntil: CONTRIBUTE_WITHOUT_END,
      };

/**
 * Makes a freshly created root Thread a Space: its color and sharing, its
 * goal, and its owner as its first member, in one batch.
 */
export const recordNewSpace = async (
  db: D1Database,
  input: {
    readonly threadId: ThreadId;
    readonly ownerUserId: UserId;
    readonly goal: string | null;
    readonly color: ThreadColor;
    /** The workspace a `workspace` Space is shared with; absent: private. */
    readonly workspaceId: string | undefined;
    readonly now: Date;
  },
) => {
  const sharing = sharingColumns(input.workspaceId);
  await db.batch([
    db
      .prepare(
        `UPDATE threads
            SET kind = 'space', color = ?3, visibility = ?4,
                workspace_access = ?5, shared_workspace_id = ?6,
                contribute_until = ?7, conversation_mode = 'agent'
          WHERE id = ?1 AND owner_user_id = ?2`,
      )
      .bind(
        input.threadId,
        input.ownerUserId,
        input.color,
        sharing.visibility,
        sharing.workspaceAccess,
        sharing.sharedWorkspaceId,
        sharing.contributeUntil,
      ),
    db
      .prepare(
        `INSERT INTO space (thread_id, goal, created_at) VALUES (?1, ?2, ?3)
         ON CONFLICT (thread_id) DO NOTHING`,
      )
      .bind(input.threadId, input.goal, input.now.getTime()),
    joinStatement(db, input.threadId, input.ownerUserId, input.now),
  ]);
};

const joinStatement = (
  db: D1Database,
  threadId: ThreadId,
  userId: UserId,
  now: Date,
) =>
  db
    .prepare(
      `INSERT INTO space_member (space_thread_id, user_id, joined_at)
       SELECT ?1, ?2, ?3 WHERE EXISTS (
         SELECT 1 FROM threads WHERE id = ?1 AND kind = 'space')
       ON CONFLICT (space_thread_id, user_id) DO NOTHING`,
    )
    .bind(threadId, userId, now.getTime());

/** The user joins the Space; true when they were not a member yet. */
export const joinSpace = async (
  db: D1Database,
  threadId: ThreadId,
  userId: UserId,
  now = new Date(),
) => (await joinStatement(db, threadId, userId, now).run()).meta.changes > 0;

export const leaveSpace = async (
  db: D1Database,
  threadId: ThreadId,
  userId: UserId,
) =>
  (
    await db
      .prepare(
        "DELETE FROM space_member WHERE space_thread_id = ?1 AND user_id = ?2",
      )
      .bind(threadId, userId)
      .run()
  ).meta.changes > 0;

/**
 * The owner's edit. Name and color are the Thread's; sharing reaches the
 * Space's whole family, as a Thread family shares as one unit.
 */
export const updateSpaceRow = async (
  db: D1Database,
  input: {
    readonly threadId: ThreadId;
    readonly ownerUserId: UserId;
    readonly name?: string;
    readonly goal?: string | null;
    readonly color?: ThreadColor;
    /** Present to change sharing: the workspace, or undefined for private. */
    readonly sharing?: { readonly workspaceId: string | undefined };
    readonly now: Date;
  },
) => {
  const statements: D1PreparedStatement[] = [];
  if (input.name !== undefined || input.color !== undefined)
    statements.push(
      db
        .prepare(
          `UPDATE threads
              SET title = COALESCE(?3, title), color = COALESCE(?4, color),
                  title_pending_until = CASE WHEN ?3 IS NULL
                    THEN title_pending_until END,
                  updated_at = ?5
            WHERE id = ?1 AND owner_user_id = ?2`,
        )
        .bind(
          input.threadId,
          input.ownerUserId,
          input.name ?? null,
          input.color ?? null,
          input.now.toISOString(),
        ),
    );
  if (input.goal !== undefined)
    statements.push(
      db
        .prepare(
          `INSERT INTO space (thread_id, goal, created_at) VALUES (?1, ?2, ?3)
           ON CONFLICT (thread_id) DO UPDATE SET goal = excluded.goal`,
        )
        .bind(input.threadId, input.goal, input.now.getTime()),
    );
  if (input.sharing !== undefined) {
    const sharing = sharingColumns(input.sharing.workspaceId);
    statements.push(
      db
        .prepare(
          `UPDATE threads
              SET visibility = ?3, workspace_access = ?4,
                  shared_workspace_id = ?5, contribute_until = ?6,
                  conversation_mode = 'agent', updated_at = ?7
            WHERE (id = ?1 OR parent_thread_id = ?1) AND owner_user_id = ?2
              AND lifecycle_state != 'deleted'`,
        )
        .bind(
          input.threadId,
          input.ownerUserId,
          sharing.visibility,
          sharing.workspaceAccess,
          sharing.sharedWorkspaceId,
          sharing.contributeUntil,
          input.now.toISOString(),
        ),
    );
    // Made private, the Space keeps only its owner as a member.
    if (input.sharing.workspaceId === undefined)
      statements.push(
        db
          .prepare(
            `DELETE FROM space_member
              WHERE space_thread_id = ?1 AND user_id != ?2`,
          )
          .bind(input.threadId, input.ownerUserId),
      );
  }
  if (statements.length > 0) await db.batch(statements);
};

/** The Thread IDs of a Space's family, for realtime updates. */
export const spaceFamilyIds = async (db: D1Database, threadId: ThreadId) =>
  (
    await db
      .prepare(
        `SELECT id FROM threads
          WHERE (id = ?1 OR parent_thread_id = ?1)
            AND lifecycle_state != 'deleted'`,
      )
      .bind(threadId)
      .all<{ id: ThreadId }>()
  ).results.map(({ id }) => id);

export interface SpaceThreadRow extends Record<string, unknown> {
  readonly id: ThreadId;
  readonly requested_by_user_id: string | null;
  readonly requested_by_name: string | null;
  readonly requested_by_image: string | null;
  readonly status_line: string | null;
  readonly shipped_at: number | null;
  readonly archived_at: number | null;
  /** When it last came back from the archive, in epoch milliseconds. */
  readonly restored_at: number | null;
  readonly attention_kind: "question" | "approval" | "failed" | null;
  readonly summary_files: number | null;
  /** An artifact of the thread holds an unchecked ask that mentions someone. */
  readonly open_ask: number;
  /** The thread follows a pull request that is still open. */
  readonly open_pull: number;
  readonly turn_settled_at: string | null;
  readonly turn_failed: number;
  readonly unread: number;
  readonly project_name: string;
  readonly workspace_access: "none" | "view" | "contribute";
  readonly contribute_until: string | null;
}

/**
 * The threads a Space started, newest first: its family's children, read
 * with the columns a Thread list item decodes plus what a Space card shows.
 * `viewer` is whose unread state the rows carry.
 */
export const listSpaceThreadRows = async (
  db: D1Database,
  spaceThreadId: ThreadId,
  viewer: UserId,
  /** Only this thread, for one card. */
  only?: ThreadId,
) =>
  (
    await db
      .prepare(
        `SELECT thread.id, thread.title, thread.project_id, thread.owner_user_id,
                thread.agent_instructions, thread.agent_instructions_revision,
                thread.agent_instructions_version, thread.model_selection,
                thread.runner_profile_id, thread.title_pending_until, thread.color,
                thread.parent_thread_id, thread.started_by_thread_id, thread.kind,
                thread.requested_by_user_id,
                thread.plugin_snapshot_json, thread.skill_snapshot_json,
                thread.visibility, thread.created_at, thread.updated_at,
                COALESCE(thread.last_activity_at, thread.updated_at) AS last_activity_at,
                -- A first message stored and not yet admitted is the
                -- start of the thread's first turn.
                CASE
                  WHEN EXISTS (
                    SELECT 1 FROM thread_initial_dispatch AS first_message
                     WHERE first_message.thread_id = thread.id
                       AND first_message.state = 'pending'
                  ) THEN 'working'
                  ELSE thread.activity_status
                END AS activity_status,
                thread.lifecycle_state,
                NULL AS pinned_at,
                thread.workspace_access, thread.contribute_until,
                thread.status_line, thread.shipped_at, thread.archived_at,
                thread.restored_at,
                project.name AS project_name,
                ${displayNameSql("requester", "requester_account")} AS requested_by_name,
                ${userImageSql("requester", "requester_account")} AS requested_by_image,
                attention.kind AS attention_kind,
                summary.summary_files,
                EXISTS (
                  SELECT 1 FROM thread_open_ask AS ask
                    JOIN thread_artifact AS artifact ON artifact.id = ask.artifact_id
                   WHERE ask.thread_id = thread.id AND artifact.deleted_at IS NULL
                ) AS open_ask,
                EXISTS (
                  SELECT 1 FROM thread_github_link AS link
                   WHERE link.thread_id = thread.id AND link.kind = 'pull'
                     AND json_extract(link.subject_json, '$.state') = 'open'
                ) AS open_pull,
                thread.turn_settled_at,
                thread.turn_failed, ${threadUnreadSql("thread", "?2")} AS unread
           FROM threads AS thread
           JOIN threads AS space_thread ON space_thread.id = thread.parent_thread_id
           JOIN projects AS project ON project.id = thread.project_id
           LEFT JOIN "user" AS requester ON requester.id = thread.requested_by_user_id
           LEFT JOIN personal_account AS requester_account
             ON requester_account.user_id = requester.id
           LEFT JOIN thread_attention_request AS attention
             ON attention.thread_id = thread.id
           LEFT JOIN thread_changes_state AS summary ON summary.thread_id = thread.id
          WHERE thread.parent_thread_id = ?1
            AND +thread.owner_user_id = space_thread.owner_user_id
            AND thread.lifecycle_state != 'deleted'
            AND (?3 IS NULL OR thread.id = ?3)
          ORDER BY thread.created_at DESC, thread.id DESC
          LIMIT 200`,
      )
      .bind(spaceThreadId, viewer, only ?? null)
      .all<SpaceThreadRow>()
  ).results;

export interface SpaceArtifactRow {
  readonly id: string;
  readonly title: string;
  readonly folder: string;
  readonly updated_at: number;
  readonly thread_id: ThreadId;
  readonly thread_title: string;
  readonly lifecycle_state: "active" | "archived";
}

/**
 * The live artifacts of the Space and of the threads it started (the
 * threads `listSpaceThreadRows` lists, archived included), each from a
 * thread `viewer` may open: the Space's own first, then the newest thread
 * first, the most recently saved first within a thread. `shared` is false
 * for a principal that acts for its own Threads only.
 */
export const listSpaceArtifactRows = async (
  db: D1Database,
  spaceThreadId: ThreadId,
  viewer: UserId,
  { shared, limit }: { readonly shared: boolean; readonly limit: number },
) =>
  (
    await db
      .prepare(
        `SELECT artifact.id, artifact.title, artifact.folder,
                artifact.updated_at, thread.id AS thread_id,
                thread.title AS thread_title, thread.lifecycle_state
           FROM threads AS thread
           JOIN projects AS project ON project.id = thread.project_id
           JOIN thread_artifact AS artifact
             ON artifact.thread_id = thread.id AND artifact.deleted_at IS NULL
          WHERE thread.id IN (
                  SELECT ?1
                  UNION ALL
                  SELECT child.id
                    FROM threads AS child
                    JOIN threads AS space_thread ON space_thread.id = ?1
                   WHERE child.parent_thread_id = ?1
                     AND child.lifecycle_state != 'deleted'
                     AND +child.owner_user_id = space_thread.owner_user_id)
            AND thread.lifecycle_state != 'deleted'
            AND (${spaceReadableSql("?2")})
            AND (?3 = 1 OR thread.owner_user_id = ?2)
          ORDER BY thread.id = ?1 DESC, thread.created_at DESC, thread.id DESC,
                   artifact.updated_at DESC, artifact.id
          LIMIT ?4`,
      )
      .bind(spaceThreadId, viewer, shared ? 1 : 0, limit)
      .all<SpaceArtifactRow>()
  ).results;
