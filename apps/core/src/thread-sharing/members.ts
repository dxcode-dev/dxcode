import {
  AGENT_MENTION,
  type MessageMention,
  mentionsHandle,
  type ThreadConversationMode,
  type ThreadMemberData,
} from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import { userImageSql } from "../avatars/storage.js";
import { activeMemberSql } from "../settings/members/membership-sql.js";
import { displayNameSql } from "./service.js";

/** One row per member, each carrying the Thread's mode and kind. */
const memberRows = async (db: D1Database, threadId: ThreadId) =>
  (
    await db
      .prepare(
        `SELECT "user".id AS user_id,
                ${displayNameSql('"user"', "account")} AS name,
                account.username AS handle, "user".email,
                ${userImageSql('"user"', "account")} AS image,
                thread.conversation_mode, thread.kind
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
        conversation_mode: ThreadConversationMode | null;
        kind: string | null;
      }>()
  ).results;

const memberData = (
  row: Awaited<ReturnType<typeof memberRows>>[number],
): ThreadMemberData => ({
  userId: row.user_id as UserId,
  name: (row.name?.trim() || "Member").slice(0, 256),
  handle: row.handle.slice(0, 64),
  email: row.email.slice(0, 320),
  ...(row.image === null || row.image.length > 2_048
    ? {}
    : { image: row.image }),
});

/**
 * Active members of the workspace the Thread is shared with, the owner
 * included, by name; none while the Thread is private or the owner has left
 * that workspace.
 */
export const threadMembers = async (
  db: D1Database,
  threadId: ThreadId,
): Promise<ReadonlyArray<ThreadMemberData>> =>
  (await memberRows(db, threadId)).map(memberData);

/**
 * Who can open a standalone artifact besides its owner, the owner included:
 * active members of the workspace it is shared with, by name; none while
 * it is private or the owner has left that workspace.
 */
export const standaloneArtifactMembers = async (
  db: D1Database,
  artifactId: string,
): Promise<ReadonlyArray<ThreadMemberData>> =>
  (
    await db
      .prepare(
        `SELECT "user".id AS user_id,
                ${displayNameSql('"user"', "account")} AS name,
                account.username AS handle, "user".email,
                ${userImageSql('"user"', "account")} AS image
           FROM thread_artifact AS artifact
           JOIN organization ON organization.id = artifact.shared_workspace_id
                            AND organization.lifecycleState = 'active'
           JOIN member ON member.organizationId = organization.id
           JOIN "user" ON "user".id = member.userId
           JOIN personal_account AS account ON account.user_id = "user".id
          WHERE artifact.id = ?1 AND artifact.thread_id IS NULL
            AND artifact.workspace_access != 'none'
            AND ${activeMemberSql("organization.id", "artifact.owner_user_id")}
          ORDER BY name COLLATE NOCASE, "user".id
          LIMIT 500`,
      )
      .bind(artifactId)
      .all<{
        user_id: string;
        name: string | null;
        handle: string;
        email: string;
        image: string | null;
      }>()
  ).results.map((row) =>
    memberData({ ...row, conversation_mode: null, kind: null }),
  );

/**
 * A shared Thread's members with its mode and kind, in one read; no
 * conversation while it is private. A Space is always in agent mode: every
 * message in it goes to its agent.
 */
export const sharedThreadConversation = async (
  db: D1Database,
  threadId: ThreadId,
): Promise<{
  readonly members: ReadonlyArray<ThreadMemberData>;
  readonly conversation?: {
    readonly mode: ThreadConversationMode;
    readonly space: boolean;
  };
}> => {
  const rows = await memberRows(db, threadId);
  const first = rows[0];
  if (first === undefined) return { members: [] };
  const space = first.kind === "space";
  return {
    members: rows.map(memberData),
    conversation: {
      mode: space ? "agent" : (first.conversation_mode ?? "agent"),
      space,
    },
  };
};

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

/**
 * dx's name for a message that tags someone, so a notification can open the
 * Thread at it. It derives from the delivery's idempotency key, which a
 * client reuses on retry, so a retried message carries an identical tag.
 */
export const messageIdFor = async (threadId: ThreadId, deliveryKey: string) => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`dx-message\n${threadId}\n${deliveryKey}`),
  );
  return `msg_${[...new Uint8Array(digest)]
    .slice(0, 12)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
};

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
