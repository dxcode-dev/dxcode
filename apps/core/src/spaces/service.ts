import type {
  SpaceData,
  SpaceErrorCode,
  SpaceThreadItem,
  SpaceThreadState,
} from "@dx/api";
import type { ProjectId, ThreadId, UserId } from "@dx/domain";
import { DateTime, Effect } from "effect";
import { threadProjectReachableSql } from "../settings/members/membership-sql.js";
import {
  decorateSharingRows,
  ownerWorkspaceId,
} from "../thread-sharing/service.js";
import { threadAttentionFields } from "../threads/attention-d1.js";
import {
  projectlessField,
  threadListItem,
} from "../threads/list-projection-d1.js";
import { decodeThreadRows } from "../threads/repository-d1.js";
import {
  defaultSpaceColor,
  listSpaceThreadRows,
  readSpaceMembers,
  type SpaceMemberRow,
  type SpaceRow,
  type SpaceThreadRow,
} from "./repository-d1.js";

export class SpaceError extends Error {
  constructor(
    readonly code: SpaceErrorCode,
    readonly status: 400 | 403 | 404 | 409 | 503,
    message: string,
  ) {
    super(message);
  }
}

export const spaceNotFound = () =>
  new SpaceError("SPACE_NOT_FOUND", 404, "Space not found.");

const timestamp = (value: string | number) =>
  DateTime.makeUnsafe(new Date(value));

const memberData = (row: SpaceMemberRow) => ({
  userId: row.user_id,
  name: (row.name?.trim() || "Member").slice(0, 256),
  ...(row.handle === null || row.handle === ""
    ? {}
    : { handle: row.handle.slice(0, 64) }),
  ...(row.image === null || row.image.length > 2_048
    ? {}
    : { avatarUrl: row.image }),
});

/** Space rows as the API returns them, with their members. */
export const spaceData = async (
  db: D1Database,
  rows: ReadonlyArray<SpaceRow>,
): Promise<ReadonlyArray<SpaceData>> => {
  const members = await readSpaceMembers(
    db,
    rows.map(({ id }) => id),
  );
  return rows.map((row) => ({
    threadId: row.id,
    name: row.title,
    goal: row.goal === null || row.goal === "" ? null : row.goal,
    color: row.color ?? defaultSpaceColor(row.id),
    projectId: row.project_id as ProjectId,
    projectName: row.project_name.slice(0, 256),
    sharing: row.workspace_access === "none" ? "private" : "workspace",
    ownerUserId: row.owner_user_id,
    members: (members.get(row.id) ?? []).map(memberData),
    joined: row.joined === 1,
    access: row.access,
    lifecycleState: row.lifecycle_state,
    statusLine: row.status_line,
    waitingOnInput: row.status_line !== null && row.waiting_on_input === 1,
    createdAt: timestamp(row.created_at),
    lastActivityAt: timestamp(row.last_activity_at),
  }));
};

/**
 * The workspace a Space in this Project is shared with: the Project's own
 * workspace, or for a personal Project the owner's. Undefined when the owner
 * has none; throws when the owner cannot reach the Project.
 */
export const spaceWorkspaceId = async (
  db: D1Database,
  projectId: string,
  ownerUserId: UserId,
): Promise<string | undefined> => {
  const project = await db
    .prepare(
      `SELECT project.workspace_id FROM projects AS project
        WHERE project.id = ?1 AND project.deleted_at IS NULL
          AND ${threadProjectReachableSql("project", "?2")}`,
    )
    .bind(projectId, ownerUserId)
    .first<{ workspace_id: string | null }>();
  if (project === null)
    throw new SpaceError("PROJECT_NOT_FOUND", 404, "Project not found.");
  return project.workspace_id ?? (await ownerWorkspaceId(db, ownerUserId));
};

/**
 * Where a Space's thread stands, first match wins:
 * - `archived`: archived; `shipped` instead when its work shipped
 *   (`shipped_at`: it reached the default branch, its pull request merged,
 *   or Ship archived it);
 * - `working`: a turn is running, its first one from when the first message
 *   is stored, shipped or not: a shipped thread asked for more is open again;
 * - `needs_you`: it asked a person for something: an open ask in one of its
 *   artifacts, or a recorded question or approval;
 * - `failed`: its last turn failed, unless it only waits for its Claude
 *   plan to reset and then runs again by itself (`plan_wait`), or the
 *   failure came before the thread shipped;
 * - `ready_to_ship`: it finished with an open pull request, or, unshipped,
 *   with uncommitted changes;
 * - `shipped`: it shipped and rests with nothing new;
 * - `idle`: it finished with nothing to ship.
 */
export const spaceThreadState = (row: {
  readonly lifecycle_state: unknown;
  readonly activity_status: unknown;
  readonly shipped_at: number | null;
  readonly attention_kind: string | null;
  readonly open_ask?: number | null;
  readonly open_pull?: number | null;
  readonly turn_failed: number;
  readonly turn_settled_at?: string | null;
  readonly plan_wait?: number | null;
  readonly summary_files: number | null;
}): SpaceThreadState => {
  const shipped = row.shipped_at !== null;
  if (row.lifecycle_state === "archived")
    return shipped ? "shipped" : "archived";
  if (row.activity_status === "working") return "working";
  if (
    row.open_ask === 1 ||
    row.attention_kind === "question" ||
    row.attention_kind === "approval"
  )
    return "needs_you";
  // A failure from before the thread shipped is history, not news.
  const settledSinceShipped =
    !shipped ||
    Date.parse(row.turn_settled_at ?? "") > (row.shipped_at ?? Infinity);
  if (
    row.plan_wait !== 1 &&
    settledSinceShipped &&
    (row.turn_failed === 1 || row.attention_kind === "failed")
  )
    return "failed";
  if (row.open_pull === 1 || (!shipped && (row.summary_files ?? 0) > 0))
    return "ready_to_ship";
  return shipped ? "shipped" : "idle";
};

/** The threads a Space started, as `viewer` sees them. */
export const spaceThreadItems = async (
  db: D1Database,
  spaceThreadId: ThreadId,
  viewer: UserId,
  viewerAccess: "owner" | "contribute" | "view",
  /** Only this thread, for one card. */
  only?: ThreadId,
): Promise<ReadonlyArray<SpaceThreadItem>> => {
  const rows = await listSpaceThreadRows(db, spaceThreadId, viewer, only);
  const threads = await Effect.runPromise(decodeThreadRows(rows));
  const byId = new Map<string, SpaceThreadRow>(
    rows.map((row) => [row.id, row]),
  );
  const decorations = new Map();
  for (let index = 0; index < rows.length; index += 50)
    for (const [id, decoration] of await decorateSharingRows(
      db,
      rows.slice(index, index + 50).map((row) => ({
        id: row.id,
        workspace_access: row.workspace_access,
        contribute_until: row.contribute_until,
      })),
    ))
      decorations.set(id, decoration);
  return threads.flatMap((thread): SpaceThreadItem[] => {
    const row = byId.get(thread.id);
    if (row === undefined) return [];
    const projectName = row.project_name.slice(0, 256);
    return [
      {
        ...threadListItem(thread),
        ...(viewerAccess === "owner"
          ? {}
          : { access: viewerAccess, projectName }),
        ...projectlessField(projectName),
        ...decorations.get(thread.id),
        ...threadAttentionFields(row),
        requestedBy:
          row.requested_by_user_id === null
            ? null
            : {
                userId: row.requested_by_user_id as UserId,
                name: (row.requested_by_name?.trim() || "Member").slice(0, 256),
                ...(row.requested_by_image === null ||
                row.requested_by_image.length > 2_048
                  ? {}
                  : { avatarUrl: row.requested_by_image }),
              },
        statusLine: row.status_line,
        state: spaceThreadState({
          lifecycle_state: thread.lifecycleState,
          activity_status: thread.activityStatus,
          shipped_at: row.shipped_at,
          attention_kind: row.attention_kind,
          open_ask: row.open_ask,
          open_pull: row.open_pull,
          turn_failed: row.turn_failed,
          turn_settled_at: row.turn_settled_at,
          plan_wait: row.plan_wait,
          summary_files: row.summary_files,
        }),
        shippedAt: row.shipped_at === null ? null : timestamp(row.shipped_at),
        archivedAt:
          row.archived_at === null ? null : timestamp(row.archived_at),
      },
    ];
  });
};
