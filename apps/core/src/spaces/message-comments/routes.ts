import {
  COMMENTED_MESSAGE_ID_PATTERN,
  CreateMessageCommentRequestSchema,
  type MessageCommentErrorCode,
  type MessageCommentListResponse,
  type MessageCommentResponse,
  type MessageCommentSummaryListResponse,
  SPACE_POST_ID_PATTERN,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { Option, Schema } from "effect";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../../http/types.js";
import { spaceLogger } from "../../logging.js";
import { scheduleRealtimeInvalidation } from "../../realtime/publication.js";
import { threadReaders } from "../../thread-artifacts/ask-effects.js";
import { announcePosts } from "../posts/effects.js";
import { readSpacePost } from "../posts/store.js";
import { messageCommented } from "./effects.js";
import {
  addMessageComment,
  isSpaceThread,
  listMessageCommentSummaries,
  listMessageComments,
} from "./store.js";

const MESSAGES: Record<MessageCommentErrorCode, string> = {
  INVALID_REQUEST: "Request validation failed.",
  MESSAGE_COMMENTS_UNAVAILABLE: "Comments are temporarily unavailable.",
  MESSAGE_COMMENT_LIMIT: "This message holds as many comments as it can.",
  NOT_A_SPACE: "Only a Space's messages take comments.",
  POST_NOT_FOUND: "Post not found.",
};

const STATUS = {
  INVALID_REQUEST: 400,
  MESSAGE_COMMENTS_UNAVAILABLE: 503,
  MESSAGE_COMMENT_LIMIT: 409,
  NOT_A_SPACE: 404,
  POST_NOT_FOUND: 404,
} as const satisfies Record<MessageCommentErrorCode, number>;

const refuse = (
  context: Context<AppEnv>,
  code: MessageCommentErrorCode,
  message = MESSAGES[code],
) => {
  context.header("Cache-Control", "no-store");
  return context.json(
    {
      status: "error",
      data: { code, message, requestId: context.get("requestId") },
    },
    STATUS[code],
  );
};

const param = (context: Context<AppEnv>, name: string) =>
  context.req.param(name) ?? "";

/** Runs after the response where there is one, inline otherwise. */
const afterResponse = (context: Context<AppEnv>, work: Promise<unknown>) => {
  const settled = work.catch(() => undefined);
  try {
    context.executionCtx.waitUntil(settled);
  } catch {
    // No ExecutionContext (a test): the work still runs.
  }
};

/**
 * Serves `/v1/threads/:threadId/message-comments*` behind `authorizeThread`:
 * everyone who can open the Space reads comments; the owner and Contribute
 * members comment (`viewerMayRequest` refuses a View member's POST). Only a
 * Space's messages take comments.
 */
const createMessageCommentRoutes = () => {
  const handle =
    (
      operation: string,
      run: (context: Context<AppEnv>, db: D1Database) => Promise<Response>,
    ) =>
    async (context: Context<AppEnv>) => {
      const db = context.env.DB;
      if (db === undefined)
        return refuse(context, "MESSAGE_COMMENTS_UNAVAILABLE");
      try {
        if (!(await isSpaceThread(db, param(context, "threadId"))))
          return refuse(context, "NOT_A_SPACE");
        return await run(context, db);
      } catch (cause) {
        spaceLogger.error("Message comment request failed.", {
          event: "space_message_comment_request_failed",
          operation,
          requestId: context.get("requestId"),
          threadId: param(context, "threadId"),
          cause,
        });
        return refuse(context, "MESSAGE_COMMENTS_UNAVAILABLE");
      }
    };

  const messageIdOf = (context: Context<AppEnv>) => {
    const messageId = param(context, "messageId");
    return COMMENTED_MESSAGE_ID_PATTERN.test(messageId) ? messageId : undefined;
  };

  return new Hono<AppEnv>()
    .get(
      "/:threadId/message-comments",
      handle("list-summaries", async (context, db) => {
        const items = await listMessageCommentSummaries(
          db,
          param(context, "threadId"),
        );
        context.header("Cache-Control", "no-store");
        return context.json<MessageCommentSummaryListResponse>({
          status: "success",
          data: { items: [...items] },
        });
      }),
    )
    .get(
      "/:threadId/message-comments/:messageId",
      handle("list", async (context, db) => {
        const messageId = messageIdOf(context);
        if (messageId === undefined) return refuse(context, "INVALID_REQUEST");
        const { message, comments } = await listMessageComments(
          db,
          param(context, "threadId"),
          messageId,
        );
        context.header("Cache-Control", "no-store");
        return context.json<MessageCommentListResponse>({
          status: "success",
          data: { message, comments: [...comments] },
        });
      }),
    )
    .post(
      "/:threadId/message-comments/:messageId",
      handle("add", async (context, db) => {
        const messageId = messageIdOf(context);
        const input = Option.getOrUndefined(
          Schema.decodeUnknownOption(CreateMessageCommentRequestSchema)(
            await context.req.json().catch(() => undefined),
          ),
        );
        if (messageId === undefined || input === undefined)
          return refuse(context, "INVALID_REQUEST");
        const threadId = param(context, "threadId");
        // The person acting, not the owner a Contribute member acts as.
        const actor = context.get("actor") ?? context.get("principal");
        // A message's author is someone who can open the Space, or no one.
        const authorUserId = input.message.authorUserId;
        const { readers } =
          authorUserId === undefined
            ? { readers: new Set<string>() }
            : await threadReaders(db, threadId);
        // A post is quoted as it is, whatever the client says of it.
        const post = SPACE_POST_ID_PATTERN.test(messageId)
          ? await readSpacePost(db, threadId, messageId)
          : undefined;
        if (post === null) return refuse(context, "POST_NOT_FOUND");
        const added = await addMessageComment(db, {
          threadId,
          messageId,
          authorUserId: actor.userId,
          body: input.body,
          message:
            post !== undefined
              ? {
                  excerpt: post.text,
                  ...(post.author_user_id === null
                    ? {}
                    : { authorUserId: post.author_user_id }),
                  sentAt: post.created_at,
                }
              : {
                  excerpt: input.message.excerpt,
                  ...(authorUserId !== undefined && readers.has(authorUserId)
                    ? { authorUserId }
                    : {}),
                  ...(input.message.sentAt === undefined
                    ? {}
                    : { sentAt: input.message.sentAt }),
                },
        });
        if (added.kind === "limit")
          return refuse(context, "MESSAGE_COMMENT_LIMIT");
        if (added.kind === "invalid")
          return refuse(context, "INVALID_REQUEST", added.message);
        await scheduleRealtimeInvalidation(
          () => context.executionCtx,
          context.env,
          threadId as ThreadId,
          "comments.invalidated",
        );
        // A post's replies row counts its comments.
        if (post !== undefined) await announcePosts(context.env, threadId);
        // Awaited: by the 201 a comment that asks dx is in the agent's
        // queue, so the main chat shows it working right away.
        await messageCommented(
          context.env,
          {
            threadId,
            commentId: added.comment.id,
            body: added.comment.body,
            message: added.message,
            actor,
          },
          { waitUntil: (promise) => afterResponse(context, promise) },
        );
        context.header("Cache-Control", "no-store");
        return context.json<MessageCommentResponse>(
          { status: "success", data: { comment: added.comment } },
          201,
        );
      }),
    );
};

export const messageCommentRoutes = createMessageCommentRoutes();
