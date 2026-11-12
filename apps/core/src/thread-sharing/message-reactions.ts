import {
  type ListMessageReactionsResponse,
  type MessageReaction,
  type MessageReactionErrorCode,
  MessageReactionSchema,
  type MessageReactions,
  type MessageReactionsResponse,
  REACTED_MESSAGE_ID_PATTERN,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { Option, Schema } from "effect";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../http/types.js";
import { threadSharingLogger } from "../logging.js";
import { scheduleRealtimeInvalidation } from "../realtime/publication.js";

/**
 * Reactions on a shared Thread's messages (`@dx/api` message-reactions.ts),
 * behind `authorizeThread`: the owner and every member the Thread is shared
 * with, View members too (`viewerMayRequest`), react with the five a Space's
 * posts take. A Thread that is private, or a Space (whose posts carry their
 * own), shows none and takes none; its rows stay for when it is shared again.
 */

/** The most reactions one Thread's list reads. */
const LIST_LIMIT = 5_000;

const MESSAGES: Record<MessageReactionErrorCode, string> = {
  INVALID_REQUEST: "Request validation failed.",
  THREAD_NOT_SHARED: "Only a shared Thread's messages take reactions.",
  THREAD_ARCHIVED: "This Thread is archived.",
  MESSAGE_REACTIONS_UNAVAILABLE: "Reactions are temporarily unavailable.",
};

const STATUS = {
  INVALID_REQUEST: 400,
  THREAD_NOT_SHARED: 409,
  THREAD_ARCHIVED: 409,
  MESSAGE_REACTIONS_UNAVAILABLE: 503,
} as const satisfies Record<MessageReactionErrorCode, number>;

const refuse = (context: Context<AppEnv>, code: MessageReactionErrorCode) => {
  context.header("Cache-Control", "no-store");
  return context.json(
    {
      status: "error",
      data: {
        code,
        message: MESSAGES[code],
        requestId: context.get("requestId"),
      },
    },
    STATUS[code],
  );
};

/** Whether the Thread takes reactions: shared with a workspace, not a Space. */
const threadShared = async (db: D1Database, threadId: string) =>
  (await db
    .prepare(
      `SELECT 1 AS shared FROM threads
        WHERE id = ?1 AND workspace_access != 'none'
          AND shared_workspace_id IS NOT NULL
          AND ifnull(kind, 'thread') != 'space'`,
    )
    .bind(threadId)
    .first<{ shared: number }>()) !== null;

interface ReactionRow {
  readonly message_id: string;
  readonly user_id: string;
  readonly reaction: MessageReaction;
}

/** Rows grouped by message, then by reaction, in the order first given. */
const groupReactions = (
  rows: ReadonlyArray<ReactionRow>,
  viewerUserId: string,
): MessageReactions[] => {
  const messages = new Map<
    string,
    Map<MessageReaction, { count: number; mine: boolean }>
  >();
  for (const row of rows) {
    const reactions = messages.get(row.message_id) ?? new Map();
    const entry = reactions.get(row.reaction) ?? { count: 0, mine: false };
    entry.count += 1;
    if (row.user_id === viewerUserId) entry.mine = true;
    reactions.set(row.reaction, entry);
    messages.set(row.message_id, reactions);
  }
  return [...messages].map(([messageId, reactions]) => ({
    messageId,
    reactions: [...reactions].map(([reaction, { count, mine }]) => ({
      reaction,
      count,
      mine,
      agent: false,
    })),
  }));
};

const readReactions = async (
  db: D1Database,
  threadId: string,
  viewerUserId: string,
  messageId?: string,
) =>
  groupReactions(
    (
      await db
        .prepare(
          `SELECT message_id, user_id, reaction FROM thread_reaction
            WHERE thread_id = ?1 AND (?2 IS NULL OR message_id = ?2)
            ORDER BY created_at, message_id, user_id
            LIMIT ${LIST_LIMIT}`,
        )
        .bind(threadId, messageId ?? null)
        .all<ReactionRow>()
    ).results,
    viewerUserId,
  );

const decodeReaction = Schema.decodeUnknownOption(MessageReactionSchema);

const createMessageReactionRoutes = () => {
  const handle =
    (
      operation: string,
      run: (
        context: Context<AppEnv>,
        db: D1Database,
        threadId: string,
        /** The person acting, not the owner a member acts as. */
        actorUserId: string,
      ) => Promise<Response>,
    ) =>
    async (context: Context<AppEnv>) => {
      const db = context.env.DB;
      if (db === undefined)
        return refuse(context, "MESSAGE_REACTIONS_UNAVAILABLE");
      const threadId = context.req.param("threadId") ?? "";
      const actor = context.get("actor") ?? context.get("principal");
      try {
        return await run(context, db, threadId, actor.userId);
      } catch (cause) {
        threadSharingLogger.error("Message reaction request failed.", {
          event: "thread_reaction_request_failed",
          operation,
          requestId: context.get("requestId"),
          threadId,
          cause,
        });
        return refuse(context, "MESSAGE_REACTIONS_UNAVAILABLE");
      }
    };

  const set = (on: boolean) =>
    handle(on ? "add" : "remove", async (context, db, threadId, userId) => {
      const messageId = context.req.param("messageId") ?? "";
      const reaction = Option.getOrUndefined(
        decodeReaction(context.req.param("reaction")),
      );
      if (!REACTED_MESSAGE_ID_PATTERN.test(messageId) || reaction === undefined)
        return refuse(context, "INVALID_REQUEST");
      if (context.get("threadLifecycleState") === "archived")
        return refuse(context, "THREAD_ARCHIVED");
      if (!(await threadShared(db, threadId)))
        return refuse(context, "THREAD_NOT_SHARED");
      const changed = on
        ? await db
            .prepare(
              `INSERT OR IGNORE INTO thread_reaction
                 (thread_id, message_id, user_id, reaction, created_at)
               VALUES (?1, ?2, ?3, ?4, ?5)`,
            )
            .bind(threadId, messageId, userId, reaction, Date.now())
            .run()
        : await db
            .prepare(
              `DELETE FROM thread_reaction
                WHERE thread_id = ?1 AND message_id = ?2
                  AND user_id = ?3 AND reaction = ?4`,
            )
            .bind(threadId, messageId, userId, reaction)
            .run();
      if (changed.meta.changes > 0)
        await scheduleRealtimeInvalidation(
          () => context.executionCtx,
          context.env,
          threadId as ThreadId,
          "reactions.invalidated",
        );
      const [current] = await readReactions(db, threadId, userId, messageId);
      context.header("Cache-Control", "no-store");
      return context.json<MessageReactionsResponse>({
        status: "success",
        data: current ?? { messageId, reactions: [] },
      });
    });

  return new Hono<AppEnv>()
    .get(
      "/:threadId/message-reactions",
      handle("list", async (context, db, threadId, userId) => {
        const shared = await threadShared(db, threadId);
        context.header("Cache-Control", "no-store");
        return context.json<ListMessageReactionsResponse>({
          status: "success",
          data: {
            shared,
            items: shared ? await readReactions(db, threadId, userId) : [],
          },
        });
      }),
    )
    .put("/:threadId/message-reactions/:messageId/:reaction", set(true))
    .delete("/:threadId/message-reactions/:messageId/:reaction", set(false));
};

export const messageReactionRoutes = createMessageReactionRoutes();
