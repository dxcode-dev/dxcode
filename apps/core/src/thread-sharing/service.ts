import {
  THREAD_CONTRIBUTE_DURATION_MS,
  type ThreadParticipantData,
  type ThreadSharingData,
  type ThreadSharingErrorCode,
  type UpdateThreadSharingRequest,
} from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import { DateTime } from "effect";
import { threadProjectReachableSql } from "../settings/members/membership-sql.js";
import { sharedThreadAccessSql, sharedThreadVisibleSql } from "./access.js";

export class ThreadSharingError extends Error {
  constructor(
    readonly code: ThreadSharingErrorCode,
    readonly status: 400 | 403 | 404 | 409 | 503,
    message: string,
  ) {
    super(message);
  }
}

const BATCH = 50;

const chunks = <A>(
  items: ReadonlyArray<A>,
): ReadonlyArray<ReadonlyArray<A>> => {
  const result: Array<ReadonlyArray<A>> = [];
  for (let index = 0; index < items.length; index += BATCH)
    result.push(items.slice(index, index + BATCH));
  return result;
};

const placeholders = (count: number, offset = 1) =>
  Array.from({ length: count }, (_, index) => `?${index + offset}`).join(", ");

/** A view refreshes `last_seen_at` at most this often. */
const PARTICIPANT_SEEN_INTERVAL_MS = 5 * 60 * 1_000;

export const recordParticipant = async (
  db: D1Database,
  threadId: ThreadId,
  userId: UserId,
  { message }: { readonly message: boolean },
  now = new Date(),
) => {
  const at = now.toISOString();
  // Thread detail is refetched often; skip the write for a recent viewer.
  await db
    .prepare(
      `INSERT INTO thread_participant
         (thread_id, user_id, first_seen_at, last_seen_at, last_message_at)
       VALUES (?1, ?2, ?3, ?3, ?4)
       ON CONFLICT (thread_id, user_id) DO UPDATE
         SET last_seen_at = excluded.last_seen_at,
             last_message_at = COALESCE(excluded.last_message_at,
                                        thread_participant.last_message_at)
       WHERE excluded.last_message_at IS NOT NULL
          OR thread_participant.last_seen_at < ?5`,
    )
    .bind(
      threadId,
      userId,
      at,
      message ? at : null,
      new Date(now.getTime() - PARTICIPANT_SEEN_INTERVAL_MS).toISOString(),
    )
    .run();
};

/**
 * SQL expression: the name a user chose in Account settings, else their sign-in
 * name. `user` and `account` are aliases of "user" and a LEFT JOIN of
 * personal_account.
 */
export const displayNameSql = (user: string, account: string) =>
  `COALESCE(NULLIF(trim(${account}.display_name), ''), ${user}.name)`;

/**
 * The name dx shows for a user, or "Member" when they have none, and their
 * username. Never their email: both travel to the model and to every member
 * of a Thread.
 */
export const userIdentity = async (db: D1Database, userId: UserId) => {
  const row = await db
    .prepare(
      `SELECT ${displayNameSql('"user"', "account")} AS name,
              account.username AS handle
         FROM "user"
         LEFT JOIN personal_account AS account ON account.user_id = "user".id
        WHERE "user".id = ?`,
    )
    .bind(userId)
    .first<{ name: string | null; handle?: string | null }>();
  return {
    name: (row?.name?.trim() || "Member").slice(0, 256),
    ...(typeof row?.handle === "string" && row.handle !== ""
      ? { handle: row.handle.slice(0, 64) }
      : {}),
  };
};

interface SharingRow {
  readonly id: string;
  readonly workspace_access: "none" | "view" | "contribute";
  readonly contribute_until: string | null;
}

const sharingData = (
  row: SharingRow,
  now: Date,
): ThreadSharingData | undefined => {
  if (row.workspace_access === "none") return undefined;
  const until =
    row.contribute_until === null ? undefined : new Date(row.contribute_until);
  return row.workspace_access === "contribute" &&
    until !== undefined &&
    until.getTime() > now.getTime()
    ? {
        workspaceAccess: "contribute",
        contributeUntil: DateTime.makeUnsafe(until),
      }
    : { workspaceAccess: "view" };
};

interface ParticipantRow {
  readonly thread_id: string;
  readonly user_id: string;
  readonly name: string | null;
  readonly handle: string | null;
  readonly image: string | null;
  readonly owner: number;
}

const participantData = (row: ParticipantRow): ThreadParticipantData => ({
  userId: row.user_id as UserId,
  name: (row.name ?? "").slice(0, 256) || "Member",
  ...(row.handle === null ? {} : { handle: row.handle.slice(0, 64) }),
  ...(row.image === null || row.image.length > 2_048
    ? {}
    : { image: row.image }),
  ...(row.owner === 1 ? { owner: true } : {}),
});

export interface ThreadSharingDecoration {
  readonly sharing?: ThreadSharingData;
  readonly participants?: ReadonlyArray<ThreadParticipantData>;
}

/**
 * Sharing state and participants for Threads. `participants` is present for a
 * shared Thread, or always when `includeParticipants` is set (Thread detail
 * keeps names for messages sent while it was shared).
 */
export const threadSharingDecorations = async (
  db: D1Database,
  threadIds: ReadonlyArray<ThreadId>,
  { includeParticipants = false, now = new Date() } = {},
): Promise<ReadonlyMap<ThreadId, ThreadSharingDecoration>> => {
  const decorations = new Map<ThreadId, ThreadSharingDecoration>();
  for (const ids of chunks(threadIds)) {
    const sharing = await db
      .prepare(
        `SELECT id, workspace_access, contribute_until
           FROM threads WHERE id IN (${placeholders(ids.length)})`,
      )
      .bind(...ids)
      .all<SharingRow>();
    const sharedIds = new Set<string>();
    for (const row of sharing.results) {
      const data = sharingData(row, now);
      if (data !== undefined) sharedIds.add(row.id);
      decorations.set(
        row.id as ThreadId,
        data === undefined ? {} : { sharing: data },
      );
    }
    const participantIds = includeParticipants
      ? ids
      : ids.filter((id) => sharedIds.has(id));
    if (participantIds.length === 0) continue;
    const participants = await db
      .prepare(
        `SELECT thread.id AS thread_id, "user".id AS user_id,
                ${displayNameSql('"user"', "account")} AS name,
                account.username AS handle, "user".image, 1 AS owner,
                0 AS rank, '' AS seen
           FROM threads AS thread
           JOIN "user" ON "user".id = thread.owner_user_id
           LEFT JOIN personal_account AS account ON account.user_id = "user".id
          WHERE thread.id IN (${placeholders(participantIds.length)})
         UNION ALL
         SELECT participant.thread_id, "user".id,
                ${displayNameSql('"user"', "account")}, account.username,
                "user".image, 0, 1,
                COALESCE(participant.last_message_at, participant.last_seen_at)
           FROM thread_participant AS participant
           JOIN threads AS thread ON thread.id = participant.thread_id
           JOIN "user" ON "user".id = participant.user_id
           LEFT JOIN personal_account AS account ON account.user_id = "user".id
          WHERE participant.thread_id IN (${placeholders(participantIds.length)})
            AND participant.user_id != thread.owner_user_id
         ORDER BY thread_id, rank, seen DESC`,
      )
      .bind(...participantIds)
      .all<ParticipantRow>();
    const byThread = new Map<string, Array<ThreadParticipantData>>();
    for (const row of participants.results) {
      const list = byThread.get(row.thread_id) ?? [];
      if (list.length < 50) list.push(participantData(row));
      byThread.set(row.thread_id, list);
    }
    for (const [threadId, list] of byThread) {
      const id = threadId as ThreadId;
      if (!includeParticipants && list.length < 2 && !sharedIds.has(threadId))
        continue;
      decorations.set(id, { ...decorations.get(id), participants: list });
    }
  }
  return decorations;
};

export const skipsMultiplayerConfirmation = async (
  db: D1Database,
  userId: UserId,
): Promise<boolean> =>
  (
    await db
      .prepare(
        `SELECT skip_multiplayer_confirmation FROM thread_sharing_preference
          WHERE user_id = ?`,
      )
      .bind(userId)
      .first<{ skip_multiplayer_confirmation: number }>()
  )?.skip_multiplayer_confirmation === 1;

/** The owner's workspace, which a shared Thread is shared with. */
const ownerWorkspaceId = async (db: D1Database, userId: UserId) =>
  (
    await db
      .prepare(
        `SELECT member.organizationId AS workspace_id
           FROM member
           JOIN organization ON organization.id = member.organizationId
          WHERE member.userId = ? AND organization.lifecycleState = 'active'
          ORDER BY member.createdAt
          LIMIT 1`,
      )
      .bind(userId)
      .first<{ workspace_id: string }>()
  )?.workspace_id;

export const updateThreadSharing = async (
  db: D1Database,
  input: {
    readonly threadId: ThreadId;
    readonly ownerUserId: UserId;
    readonly request: UpdateThreadSharingRequest;
    readonly now?: Date;
  },
): Promise<{
  readonly sharing?: ThreadSharingData;
  readonly skipMultiplayerConfirmation: boolean;
}> => {
  const now = input.now ?? new Date();
  const owned = await db
    .prepare(
      `SELECT thread.id FROM threads AS thread
         JOIN projects AS project ON project.id = thread.project_id
        WHERE thread.id = ?1 AND thread.owner_user_id = ?2
          AND thread.lifecycle_state != 'deleted'
          AND ${threadProjectReachableSql("project", "?2")}`,
    )
    .bind(input.threadId, input.ownerUserId)
    .first();
  if (owned === null) {
    const shared = await db
      .prepare(
        `SELECT thread.id FROM threads AS thread
           JOIN projects AS project ON project.id = thread.project_id
          WHERE thread.id = ?1 AND thread.lifecycle_state != 'deleted'
            AND ${sharedThreadVisibleSql("thread", "project", "?2")}`,
      )
      .bind(input.threadId, input.ownerUserId)
      .first();
    throw shared === null
      ? new ThreadSharingError("THREAD_NOT_FOUND", 404, "Thread not found.")
      : new ThreadSharingError(
          "THREAD_SHARING_OWNER_ONLY",
          403,
          "Only the Thread owner can change sharing.",
        );
  }

  const { workspaceAccess, contributeFor = "7d" } = input.request;
  const workspaceId =
    workspaceAccess === "none"
      ? undefined
      : await ownerWorkspaceId(db, input.ownerUserId);
  if (workspaceAccess !== "none" && workspaceId === undefined)
    throw new ThreadSharingError(
      "THREAD_SHARING_UNAVAILABLE",
      409,
      "Join or create a workspace to share Threads.",
    );
  const contributeUntil =
    workspaceAccess === "contribute"
      ? new Date(
          now.getTime() + THREAD_CONTRIBUTE_DURATION_MS[contributeFor],
        ).toISOString()
      : null;
  const statements = [
    db
      .prepare(
        `UPDATE threads
            SET workspace_access = ?2,
                shared_workspace_id = ?3,
                contribute_until = ?4,
                visibility = CASE WHEN ?2 = 'none' THEN 'private' ELSE 'workspace' END,
                -- A private Thread is always in agent mode; sharing it again
                -- starts there too.
                conversation_mode = CASE WHEN ?2 = 'none' THEN 'agent'
                                         ELSE conversation_mode END,
                updated_at = ?5
          WHERE id = ?1`,
      )
      .bind(
        input.threadId,
        workspaceAccess,
        workspaceId ?? null,
        contributeUntil,
        now.toISOString(),
      ),
  ];
  if (input.request.skipMultiplayerConfirmation !== undefined)
    statements.push(
      db
        .prepare(
          `INSERT INTO thread_sharing_preference
             (user_id, skip_multiplayer_confirmation, updated_at)
           VALUES (?1, ?2, ?3)
           ON CONFLICT (user_id) DO UPDATE
             SET skip_multiplayer_confirmation = excluded.skip_multiplayer_confirmation,
                 updated_at = excluded.updated_at`,
        )
        .bind(
          input.ownerUserId,
          input.request.skipMultiplayerConfirmation ? 1 : 0,
          now.toISOString(),
        ),
    );
  await db.batch(statements);
  const sharing = sharingData(
    {
      id: input.threadId,
      workspace_access: workspaceAccess,
      contribute_until: contributeUntil,
    },
    now,
  );
  return {
    ...(sharing === undefined ? {} : { sharing }),
    skipMultiplayerConfirmation: await skipsMultiplayerConfirmation(
      db,
      input.ownerUserId,
    ),
  };
};

/**
 * Thread rows other members shared with `userId` that `userId` follows, most
 * recent first, with the name of each Thread's Project.
 */
export const listSharedThreadRows = async (
  db: D1Database,
  userId: UserId,
  now = new Date(),
): Promise<
  ReadonlyArray<
    Record<string, unknown> & { access: string; project_name: string }
  >
> =>
  (
    await db
      .prepare(
        `SELECT thread.id, thread.title, thread.project_id, thread.owner_user_id,
                thread.agent_instructions, thread.agent_instructions_revision,
                thread.agent_instructions_version, thread.model_selection,
                thread.runner_profile_id, thread.title_pending_until,
                thread.plugin_snapshot_json, thread.skill_snapshot_json,
                thread.visibility, thread.created_at, thread.updated_at,
                COALESCE(thread.last_activity_at, thread.updated_at) AS last_activity_at,
                thread.activity_status, thread.lifecycle_state,
                NULL AS pinned_at,
                ${sharedThreadAccessSql("thread", "?2")} AS access,
                project.name AS project_name
           FROM thread_follower AS follower
           JOIN threads AS thread ON thread.id = follower.thread_id
           JOIN projects AS project ON project.id = thread.project_id
          WHERE follower.user_id = ?1
            AND thread.lifecycle_state = 'active'
            AND ${sharedThreadVisibleSql("thread", "project", "?1")}
          ORDER BY COALESCE(thread.last_activity_at, thread.updated_at) DESC, thread.id DESC
          LIMIT 100`,
      )
      .bind(userId, now.toISOString())
      .all<Record<string, unknown> & { access: string; project_name: string }>()
  ).results;

/** Sharing fields of Thread detail for the requester. */
export const threadSharingDetail = async (
  db: D1Database,
  threadId: ThreadId,
  ownerUserId: UserId,
  access: "owner" | "contribute" | "view",
  viewerUserId: UserId,
) => {
  const [decorations, skipConfirmation, thread] = await Promise.all([
    threadSharingDecorations(db, [threadId], { includeParticipants: true }),
    access === "owner"
      ? skipsMultiplayerConfirmation(db, ownerUserId)
      : Promise.resolve(undefined),
    db
      .prepare(
        `SELECT project.name AS project_name, thread.conversation_mode,
                EXISTS (SELECT 1 FROM thread_follower AS follower
                         WHERE follower.thread_id = thread.id
                           AND follower.user_id = ?2) AS following
           FROM threads AS thread
           JOIN projects AS project ON project.id = thread.project_id
          WHERE thread.id = ?1`,
      )
      .bind(threadId, viewerUserId)
      .first<{
        project_name: string;
        conversation_mode: "agent" | "chat";
        following: number;
      }>(),
  ]);
  const { sharing, participants } = decorations.get(threadId) ?? {};
  return {
    access,
    ...(sharing === undefined ? {} : { sharing }),
    // A private Thread nobody else joined has no participant list.
    ...(participants === undefined ||
    (participants.length < 2 && sharing === undefined)
      ? {}
      : { participants }),
    ...(thread === null || access === "owner"
      ? {}
      : {
          projectName: thread.project_name.slice(0, 256),
          following: thread.following === 1,
        }),
    conversationMode:
      sharing === undefined ? "agent" : (thread?.conversation_mode ?? "agent"),
    ...(skipConfirmation === undefined
      ? {}
      : { skipMultiplayerConfirmation: skipConfirmation }),
  } as const;
};
