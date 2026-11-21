import {
  DeleteThreadMessageResponseSchema,
  EditQueuedThreadMessageResponseSchema,
  ListThreadQueuedMessagesResponseSchema,
  ThreadMessageQueueErrorResponseSchema,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { request } from "../../shared/api/client.js";
import type {
  DeleteThreadMessageInput,
  EditQueuedThreadMessageInput,
} from "./message-queue-queries.js";

const messagesPath = (threadId: ThreadId) =>
  `/v1/threads/${encodeURIComponent(threadId)}/messages`;

/**
 * The requests for queued messages and deletes, loaded when the page first
 * needs one rather than with the Thread page, with the routes' own refusals.
 */
export const listQueuedThreadMessages = async (threadId: ThreadId) =>
  (
    await request(
      `${messagesPath(threadId)}/queued`,
      ListThreadQueuedMessagesResponseSchema,
      undefined,
      ThreadMessageQueueErrorResponseSchema,
    )
  ).data.messages;

export const editQueuedThreadMessage = async (
  threadId: ThreadId,
  { submissionId, body, idempotencyKey }: EditQueuedThreadMessageInput,
) =>
  (
    await request(
      `${messagesPath(threadId)}/queued/${encodeURIComponent(submissionId)}/edit`,
      EditQueuedThreadMessageResponseSchema,
      { method: "POST", body: JSON.stringify({ body, idempotencyKey }) },
      ThreadMessageQueueErrorResponseSchema,
    )
  ).data;

export const deleteThreadMessage = async (
  threadId: ThreadId,
  input: DeleteThreadMessageInput,
) =>
  (
    await request(
      input.kind === "queued"
        ? `${messagesPath(threadId)}/queued/${encodeURIComponent(input.submissionId)}/delete`
        : `${messagesPath(threadId)}/${encodeURIComponent(input.entryId)}/delete`,
      DeleteThreadMessageResponseSchema,
      {
        method: "POST",
        body: JSON.stringify(
          input.kind === "queued"
            ? { idempotencyKey: input.idempotencyKey }
            : {
                idempotencyKey: input.idempotencyKey,
                original: input.original,
              },
        ),
      },
      ThreadMessageQueueErrorResponseSchema,
    )
  ).data;
