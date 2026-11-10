import { UserId } from "@dx/domain";
import { Schema } from "effect";
import { successResponse } from "../http/response.js";

/**
 * Comments on a Space's messages. People discuss any message of the main
 * chat beside it; the Space's agent never reads a comment unless the comment
 * mentions `@[dx](agent)`, and then it answers in the main chat. A message is
 * named by its Flue message id. Mentions are written as artifact comments
 * write them: `@[Name](user:ID)`, `@[dx](agent)`, `@[here](here)`.
 */

/** A comment's text, in characters. */
export const MESSAGE_COMMENT_MAX_LENGTH = 8_000;
/** How much of the commented message a comment keeps, in characters. */
export const MESSAGE_COMMENT_EXCERPT_MAX_LENGTH = 1_000;
/** The most comments one message holds. */
export const MESSAGE_COMMENT_LIMIT = 500;
/** How many commenters a message's summary names, most recent first. */
export const MESSAGE_COMMENT_SUMMARY_COMMENTERS = 3;

export const MESSAGE_COMMENT_ID_PATTERN = /^mcm_[0-9a-f]{32}$/;
/** A Flue message id, as transcript rows carry it. */
export const COMMENTED_MESSAGE_ID_PATTERN = /^[\w.-]{1,160}$/;

export const MessageCommentIdSchema = Schema.String.check(
  Schema.isPattern(MESSAGE_COMMENT_ID_PATTERN),
);
export const CommentedMessageIdSchema = Schema.String.check(
  Schema.isPattern(COMMENTED_MESSAGE_ID_PATTERN),
);

/** A person who wrote a comment or a commented message. */
export const MessageCommentPersonSchema = Schema.Struct({
  userId: UserId,
  name: Schema.String.check(Schema.isMaxLength(256)),
  handle: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
  avatarUrl: Schema.optional(Schema.String.check(Schema.isMaxLength(2_048))),
});
export type MessageCommentPerson = typeof MessageCommentPersonSchema.Type;

/**
 * The commented message as its first commenter saw it: its text (at most
 * `MESSAGE_COMMENT_EXCERPT_MAX_LENGTH` characters), who wrote it (null for
 * the agent, or an account that is gone), and when.
 */
export const CommentedMessageSchema = Schema.Struct({
  messageId: CommentedMessageIdSchema,
  excerpt: Schema.String,
  author: Schema.NullOr(MessageCommentPersonSchema),
  sentAt: Schema.NullOr(Schema.Number),
});
export type CommentedMessage = typeof CommentedMessageSchema.Type;

export const MessageCommentSchema = Schema.Struct({
  id: MessageCommentIdSchema,
  messageId: CommentedMessageIdSchema,
  /** Null once the author's account is deleted. */
  author: Schema.NullOr(MessageCommentPersonSchema),
  body: Schema.String,
  /** The comment mentions dx, which answers it in the main chat. */
  asksAgent: Schema.Boolean,
  createdAt: Schema.Number,
});
export type MessageComment = typeof MessageCommentSchema.Type;

/** One commented message, as the Space's Comments list and replies row show it. */
export const MessageCommentSummarySchema = Schema.Struct({
  message: CommentedMessageSchema,
  count: Schema.Int,
  lastComment: Schema.Struct({
    author: Schema.NullOr(MessageCommentPersonSchema),
    /** The comment's first line, at most 200 characters. */
    excerpt: Schema.String,
    createdAt: Schema.Number,
  }),
  /** Who commented, most recent first, at most three. */
  commenters: Schema.Array(MessageCommentPersonSchema),
});
export type MessageCommentSummary = typeof MessageCommentSummarySchema.Type;

/**
 * `GET /v1/threads/:threadId/message-comments`: every commented message of
 * the Space, in the order the messages were sent.
 */
export const MessageCommentSummaryListResponseSchema = successResponse(
  Schema.Struct({ items: Schema.Array(MessageCommentSummarySchema) }),
);
export type MessageCommentSummaryListResponse =
  typeof MessageCommentSummaryListResponseSchema.Type;

/**
 * `GET /v1/threads/:threadId/message-comments/:messageId`: the message as
 * commented (null before its first comment) and its comments, oldest first.
 */
export const MessageCommentListResponseSchema = successResponse(
  Schema.Struct({
    message: Schema.NullOr(CommentedMessageSchema),
    comments: Schema.Array(MessageCommentSchema),
  }),
);
export type MessageCommentListResponse =
  typeof MessageCommentListResponseSchema.Type;

/**
 * `POST /v1/threads/:threadId/message-comments/:messageId`: a comment. The
 * message's text, author, and time are recorded with the first comment.
 */
export const CreateMessageCommentRequestSchema = Schema.Struct({
  body: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MESSAGE_COMMENT_MAX_LENGTH),
  ),
  message: Schema.Struct({
    excerpt: Schema.String.check(Schema.isMaxLength(32_000)),
    authorUserId: Schema.optional(UserId),
    sentAt: Schema.optional(Schema.Number),
  }),
});
export type CreateMessageCommentRequest =
  typeof CreateMessageCommentRequestSchema.Type;

export const MessageCommentResponseSchema = successResponse(
  Schema.Struct({ comment: MessageCommentSchema }),
);
export type MessageCommentResponse = typeof MessageCommentResponseSchema.Type;

export type MessageCommentErrorCode =
  | "INVALID_REQUEST"
  | "MESSAGE_COMMENTS_UNAVAILABLE"
  | "MESSAGE_COMMENT_LIMIT"
  | "NOT_A_SPACE"
  | "POST_NOT_FOUND";

/** The agent's mention, as comments write it. */
export const MESSAGE_COMMENT_AGENT_MENTION = "@[dx](agent)";

/** Whether a comment's text mentions the agent. */
export const commentAsksAgent = (body: string) =>
  body.includes(MESSAGE_COMMENT_AGENT_MENTION);

/**
 * A comment's text as plain text: mentions as `@Name`, so a notification or
 * the agent reads it as people do.
 */
export const plainCommentText = (body: string) =>
  body.replace(/@\[([^\]\n]+)\]\((?:user:[A-Za-z0-9_-]+|agent|here)\)/g, "@$1");
