import {
  AGENT_MENTION,
  type MessageMention,
  mentionsHandle,
  type ThreadConversationMode,
  type ThreadMemberData,
} from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import { activeMemberSql } from "../settings/members/membership-sql.js";
import { displayNameSql } from "./service.js";

/**
 * Active members of the workspace the Thread is shared with, the owner
 * included, by name; none while the Thread is private or the owner has left
 * that workspace.
 */
export const threadMembers = async (
  db: D1Database,
  threadId: ThreadId,
): Promise<ReadonlyArray<ThreadMemberData>> =>
  (
    await db
      .prepare(
        `SELECT "user".id AS user_id,
                ${displayNameSql('"user"', "account")} AS name,
                account.username AS handle, "user".email, "user".image
           FROM threads AS thread
           JOIN organization ON organization.id = thread.shared_workspace_id
                            AND organization.lifecycleState = 'active'
           JOIN member ON member.organizationId = organization.id
           JOIN "user" ON "user".id = member.userId
           JOIN personal_account AS account ON account.user_id = "user".id
          WHERE thread.id = ?1 AND thread.workspace_access != 'none'
            -- Sharing ends when the owner leaves the workspace.
            AND ${activeMemberSql("organization.id", "thread.owner_user_id")}
          ORDER BY name COLLATE NOCASE, "user".id
          LIMIT 500`,
      )
      .bind(threadId)
      .all<{
        user_id: string;
        name: string | null;
        handle: string;
        email: string;
        image: string | null;
      }>()
  ).results.map((row) => ({
    userId: row.user_id as UserId,
    name: (row.name?.trim() || "Member").slice(0, 256),
    handle: row.handle.slice(0, 64),
    email: row.email.slice(0, 320),
    ...(row.image === null || row.image.length > 2_048
      ? {}
      : { image: row.image }),
  }));

/**
 * Who a message is for and whom it tags. `@dx` sends it to the agent; a
 * member tag without `@dx` makes it chat; an untagged message keeps the
 * Thread's current mode (`undefined` here).
 */
export const classifyMessage = (
  body: string,
  members: ReadonlyArray<Pick<ThreadMemberData, "userId" | "handle">>,
  senderId: string,
): {
  readonly mode?: ThreadConversationMode;
  readonly mentions: ReadonlyArray<MessageMention>;
} => {
  const mentions = members.flatMap((member): MessageMention[] =>
    member.handle !== AGENT_MENTION && mentionsHandle(body, member.handle)
      ? [{ handle: member.handle, userId: member.userId }]
      : [],
  );
  const agent = mentionsHandle(body, AGENT_MENTION);
  const others = mentions.some(({ userId }) => userId !== senderId);
  return {
    mentions,
    ...(agent
      ? { mode: "agent" as const }
      : others
        ? { mode: "chat" as const }
        : {}),
  };
};

/** The Thread's mode; see ThreadConversationModeSchema. */
export const conversationMode = async (
  db: D1Database,
  threadId: ThreadId,
): Promise<ThreadConversationMode> =>
  (
    await db
      .prepare("SELECT conversation_mode FROM threads WHERE id = ?1")
      .bind(threadId)
      .first<{ conversation_mode: ThreadConversationMode }>()
  )?.conversation_mode ?? "agent";

/** Records a mode a message switched to; returns whether it changed. */
export const switchConversationMode = async (
  db: D1Database,
  threadId: ThreadId,
  mode: ThreadConversationMode,
) =>
  (await db
    .prepare(
      `UPDATE threads SET conversation_mode = ?2
        WHERE id = ?1 AND conversation_mode != ?2
        RETURNING id`,
    )
    .bind(threadId, mode)
    .first()) !== null;

/** The member follows the Thread; repeat calls keep the first time. */
export const followThread = async (
  db: D1Database,
  threadId: ThreadId,
  userIds: ReadonlyArray<UserId>,
  now = new Date(),
) => {
  if (userIds.length === 0) return;
  await db.batch(
    userIds.map((userId) =>
      db
        .prepare(
          `INSERT INTO thread_follower (thread_id, user_id, followed_at)
           VALUES (?1, ?2, ?3)
           ON CONFLICT (thread_id, user_id) DO NOTHING`,
        )
        .bind(threadId, userId, now.toISOString()),
    ),
  );
};

export const unfollowThread = async (
  db: D1Database,
  threadId: ThreadId,
  userId: UserId,
) => {
  await db
    .prepare(
      "DELETE FROM thread_follower WHERE thread_id = ?1 AND user_id = ?2",
    )
    .bind(threadId, userId)
    .run();
};
