import {
  DeleteQueuedThreadMessageEndpoint,
  DeleteThreadMessageEndpoint,
  EditQueuedThreadMessageEndpoint,
  ListThreadQueuedMessagesEndpoint,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { dxClient } from "../../shared/api/client.js";
import type {
  DeleteThreadMessageInput,
  EditQueuedThreadMessageInput,
} from "./message-queue-queries.js";

/**
 * The requests for queued messages and deletes, loaded when the page first
 * needs one rather than with the Thread page, with the routes' own refusals.
 */
export const listQueuedThreadMessages = async (threadId: ThreadId) =>
  (
    await dxClient.call(ListThreadQueuedMessagesEndpoint, {
      params: { threadId },
    })
  ).data.messages;

export const editQueuedThreadMessage = async (
  threadId: ThreadId,
  { submissionId, body, idempotencyKey }: EditQueuedThreadMessageInput,
) =>
  (
    await dxClient.call(EditQueuedThreadMessageEndpoint, {
      params: { threadId, submissionId },
      body: { body, idempotencyKey },
    })
  ).data;

export const deleteThreadMessage = async (
  threadId: ThreadId,
  input: DeleteThreadMessageInput,
) =>
  (
    await (input.kind === "queued"
      ? dxClient.call(DeleteQueuedThreadMessageEndpoint, {
          params: { threadId, submissionId: input.submissionId },
          body: { idempotencyKey: input.idempotencyKey },
        })
      : dxClient.call(DeleteThreadMessageEndpoint, {
          params: { threadId, entryId: input.entryId },
          body: {
            idempotencyKey: input.idempotencyKey,
            original: input.original,
          },
        }))
  ).data;
