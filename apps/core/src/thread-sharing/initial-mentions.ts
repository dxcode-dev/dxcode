import type { MessageMention } from "@dx/api";
import { stripMessageAuthorTags } from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import type { Bindings } from "../http/types.js";
import { threadSharingLogger } from "../logging.js";
import { scheduleNotification } from "../notifications/publish.js";
import { scheduleRealtimeInvalidation } from "../realtime/publication.js";
import { INITIAL_IDEMPOTENCY_KEY } from "../threads/initial-dispatch.js";
import { classifyMessage, followThread, messageIdFor } from "./members.js";

/**
 * Whom a new Thread's first message tags (#1636). Only a Thread shared with
 * the owner's workspace from its start resolves tags, and only against that
 * workspace's active members, as a shared Thread's later messages do. The
 * first message always goes to the agent: a tag never makes it chat.
 */
export interface InitialMentions {
  /** Every member the text tags, for the message's author tag. */
  readonly mentions: ReadonlyArray<MessageMention>;
  /** Everyone tagged except the owner: they follow it and are notified. */
  readonly mentioned: ReadonlyArray<UserId>;
  readonly messageId: string;
  readonly excerpt: string;
}

/** The handles of a workspace's active members, by user ID. */
const workspaceMemberHandles = async (db: D1Database, workspaceId: string) =>
  (
    await db
      .prepare(
        `SELECT member.userId AS user_id, account.username AS handle
           FROM member
           JOIN organization ON organization.id = member.organizationId
                            AND organization.lifecycleState = 'active'
           JOIN personal_account AS account ON account.user_id = member.userId
          WHERE member.organizationId = ?1
          ORDER BY account.username
          LIMIT 500`,
      )
      .bind(workspaceId)
      .all<{ user_id: string; handle: string }>()
  ).results.map(({ user_id, handle }) => ({
    userId: user_id as UserId,
    handle,
  }));

export const resolveInitialMentions = async (
  db: D1Database,
  input: {
    readonly threadId: ThreadId;
    readonly ownerUserId: UserId;
    /** The owner's active workspace the Thread is shared with. */
    readonly sharedWorkspaceId: string;
    /** What the person wrote, without the file list. */
    readonly text: string;
  },
): Promise<InitialMentions | undefined> => {
  const text = stripMessageAuthorTags(input.text);
  if (!text.includes("@")) return undefined;
  const { mentions } = classifyMessage(
    text,
    await workspaceMemberHandles(db, input.sharedWorkspaceId),
    input.ownerUserId,
  );
  const mentioned = mentions.flatMap(({ userId }) =>
    userId === input.ownerUserId ? [] : [userId as UserId],
  );
  if (mentioned.length === 0) return undefined;
  return {
    mentions,
    mentioned,
    messageId: await messageIdFor(input.threadId, INITIAL_IDEMPOTENCY_KEY),
    excerpt: text,
  };
};

/**
 * Once the new Thread is stored with its first message: everyone it tags
 * follows it, so it is in their sidebar, and is notified through the
 * `mention` topic. Runs once, for the request that inserted the Thread.
 */
export const announceInitialMentions = async (
  executionContext: () => {
    readonly waitUntil: (promise: Promise<unknown>) => void;
  },
  bindings: Bindings,
  db: D1Database,
  input: {
    readonly threadId: ThreadId;
    readonly ownerUserId: UserId;
    readonly mentions: InitialMentions;
  },
) => {
  const { mentioned, messageId, excerpt } = input.mentions;
  await followThread(db, input.threadId, mentioned).catch((cause) =>
    threadSharingLogger.warn("Thread follower was not recorded.", {
      event: "thread_participant_record_failed",
      cause,
    }),
  );
  await scheduleNotification(executionContext, bindings, {
    topic: "mention",
    sourceKey: `mention:${input.threadId}:${messageId}`,
    recipients: mentioned,
    threadId: input.threadId,
    messageId,
    actorUserId: input.ownerUserId,
    excerpt,
  });
  // The followers' sidebars list the Thread now.
  await scheduleRealtimeInvalidation(
    executionContext,
    bindings,
    input.threadId,
    "thread.invalidated",
    "audience",
  );
};
