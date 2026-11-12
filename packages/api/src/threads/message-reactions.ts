import { Schema } from "effect";
import { successResponse } from "../http/response.js";
import { ReactionCountSchema, ReactionSchema } from "./reactions.js";

/**
 * Reactions on a shared Thread's messages: the same five a Space's posts
 * take, given by the owner and the members it is shared with. A message is
 * named by its Flue history id (`entry_…`).
 *
 * Reactions show only while the Thread is shared with a workspace. When it
 * goes back to private they are kept but hidden, and nobody can add any;
 * sharing it again shows them as they were. The Thread's agent neither sees
 * nor gives them: they are people's signals to each other.
 */

/** The messages a reaction can sit on: Flue's history ids. */
export const REACTED_MESSAGE_ID_PATTERN = /^entry_[A-Za-z0-9_-]{1,400}$/;

export const ReactedMessageIdSchema = Schema.String.check(
  Schema.isPattern(REACTED_MESSAGE_ID_PATTERN),
);

export const MessageReactionSchema = ReactionSchema;
export type MessageReaction = typeof MessageReactionSchema.Type;

/** The reactions on one message, in the order they were first given. */
export const MessageReactionsSchema = Schema.Struct({
  messageId: ReactedMessageIdSchema,
  reactions: Schema.Array(ReactionCountSchema),
});
export type MessageReactions = typeof MessageReactionsSchema.Type;

/**
 * `GET /v1/threads/:threadId/message-reactions`: every reacted message.
 * `shared` false means the Thread is private, so `items` is empty.
 */
export const ListMessageReactionsResponseSchema = successResponse(
  Schema.Struct({
    shared: Schema.Boolean,
    items: Schema.Array(MessageReactionsSchema),
  }),
);
export type ListMessageReactionsResponse =
  typeof ListMessageReactionsResponseSchema.Encoded;

/**
 * `PUT|DELETE /v1/threads/:threadId/message-reactions/:messageId/:reaction`:
 * the message's reactions as they now are.
 */
export const MessageReactionsResponseSchema = successResponse(
  MessageReactionsSchema,
);
export type MessageReactionsResponse =
  typeof MessageReactionsResponseSchema.Encoded;

export const MessageReactionErrorCode = Schema.Literals([
  "INVALID_REQUEST",
  "THREAD_NOT_SHARED",
  "THREAD_ARCHIVED",
  "MESSAGE_REACTIONS_UNAVAILABLE",
]);
export type MessageReactionErrorCode = typeof MessageReactionErrorCode.Type;
