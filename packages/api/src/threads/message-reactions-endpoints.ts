import { ThreadId } from "@dx/domain";
import { Schema } from "effect";
import { defineEndpoint } from "../http/endpoint.js";
import {
  ListMessageReactionsResponseSchema,
  MessageReactionErrorResponseSchema,
  MessageReactionSchema,
  MessageReactionsResponseSchema,
  ReactedMessageIdSchema,
} from "./message-reactions.js";
import { ThreadAccessRefusals } from "./thread-access-refusals.js";

/** The message reaction endpoints, apart from `message-reactions.ts`. */

export const ListMessageReactionsParamsSchema = Schema.Struct({
  threadId: ThreadId,
});
export const MessageReactionParamsSchema = Schema.Struct({
  threadId: ThreadId,
  messageId: ReactedMessageIdSchema,
  reaction: MessageReactionSchema,
});

const messageReactionRefusals = [
  ...ThreadAccessRefusals,
  // One union of codes, each sent with its own status.
  { status: 400, schema: MessageReactionErrorResponseSchema },
  { status: 409, schema: MessageReactionErrorResponseSchema },
  { status: 503, schema: MessageReactionErrorResponseSchema },
] as const;

export const ListMessageReactionsEndpoint = defineEndpoint({
  id: "threads.messageReactions.list",
  summary: "List reactions on the Thread's messages",
  method: "GET",
  path: "/v1/threads/:threadId/message-reactions",
  params: ListMessageReactionsParamsSchema,
  success: ListMessageReactionsResponseSchema,
  refusals: messageReactionRefusals,
});

export const AddMessageReactionEndpoint = defineEndpoint({
  id: "threads.messageReactions.add",
  summary: "React to a message",
  method: "PUT",
  path: "/v1/threads/:threadId/message-reactions/:messageId/:reaction",
  params: MessageReactionParamsSchema,
  success: MessageReactionsResponseSchema,
  refusals: messageReactionRefusals,
});

export const RemoveMessageReactionEndpoint = defineEndpoint({
  id: "threads.messageReactions.remove",
  summary: "Remove a reaction from a message",
  method: "DELETE",
  path: "/v1/threads/:threadId/message-reactions/:messageId/:reaction",
  params: MessageReactionParamsSchema,
  success: MessageReactionsResponseSchema,
  refusals: messageReactionRefusals,
});
