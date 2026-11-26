import { ThreadId } from "@dx/domain";
import { Schema } from "effect";
import { defineEndpoint } from "../http/endpoint.js";
import { ThreadMessageEntryIdSchema } from "./edit-message.js";
import {
  DeleteThreadMessageRequestSchema,
  DeleteThreadMessageResponseSchema,
  EditQueuedThreadMessageRequestSchema,
  EditQueuedThreadMessageResponseSchema,
  ListThreadQueuedMessagesResponseSchema,
  QueuedSubmissionIdSchema,
  ThreadMessageQueueErrorResponseSchema,
} from "./message-queue.js";
import { ThreadAccessRefusals } from "./thread-access-refusals.js";

/** The message queue endpoints, apart from `message-queue.ts`'s schemas. */

export const ThreadMessagesParamsSchema = Schema.Struct({ threadId: ThreadId });
export const ThreadQueuedMessageParamsSchema = Schema.Struct({
  threadId: ThreadId,
  submissionId: QueuedSubmissionIdSchema,
});
export const ThreadMessageEntryParamsSchema = Schema.Struct({
  threadId: ThreadId,
  entryId: ThreadMessageEntryIdSchema,
});

const messageQueueRefusals = [
  ...ThreadAccessRefusals,
  // One union of codes, each sent with its own status.
  { status: 400, schema: ThreadMessageQueueErrorResponseSchema },
  { status: 403, schema: ThreadMessageQueueErrorResponseSchema },
  { status: 404, schema: ThreadMessageQueueErrorResponseSchema },
  { status: 409, schema: ThreadMessageQueueErrorResponseSchema },
  { status: 502, schema: ThreadMessageQueueErrorResponseSchema },
  { status: 503, schema: ThreadMessageQueueErrorResponseSchema },
] as const;

export const ListThreadQueuedMessagesEndpoint = defineEndpoint({
  id: "threads.messages.queued",
  summary: "List the Thread's queued messages",
  method: "GET",
  path: "/v1/threads/:threadId/messages/queued",
  params: ThreadMessagesParamsSchema,
  success: ListThreadQueuedMessagesResponseSchema,
  refusals: messageQueueRefusals,
});

export const EditQueuedThreadMessageEndpoint = defineEndpoint({
  id: "threads.messages.editQueued",
  summary: "Edit a queued message",
  method: "POST",
  path: "/v1/threads/:threadId/messages/queued/:submissionId/edit",
  params: ThreadQueuedMessageParamsSchema,
  body: EditQueuedThreadMessageRequestSchema,
  success: EditQueuedThreadMessageResponseSchema,
  refusals: messageQueueRefusals,
});

export const DeleteQueuedThreadMessageEndpoint = defineEndpoint({
  id: "threads.messages.deleteQueued",
  summary: "Delete a queued message",
  method: "POST",
  path: "/v1/threads/:threadId/messages/queued/:submissionId/delete",
  params: ThreadQueuedMessageParamsSchema,
  body: DeleteThreadMessageRequestSchema,
  success: DeleteThreadMessageResponseSchema,
  refusals: messageQueueRefusals,
});

export const DeleteThreadMessageEndpoint = defineEndpoint({
  id: "threads.messages.delete",
  summary: "Delete a message the person sent",
  method: "POST",
  path: "/v1/threads/:threadId/messages/:entryId/delete",
  params: ThreadMessageEntryParamsSchema,
  body: DeleteThreadMessageRequestSchema,
  success: DeleteThreadMessageResponseSchema,
  refusals: messageQueueRefusals,
});
