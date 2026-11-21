import type { ThreadQueuedMessage } from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { ApiError } from "../../shared/api/client.js";
import { threadKeys } from "./thread-queries.js";

export const threadQueuedMessagesKey = (userId: UserId, threadId: ThreadId) =>
  [...threadKeys.all(userId), "queued-messages", threadId] as const;

/**
 * The viewer's own messages that wait in the Thread's queue for the agent to
 * read them, including ones sent from another tab or device. The page reads
 * them only while the agent works; nothing waits otherwise.
 */
export const threadQueuedMessagesQueryOptions = (
  userId: UserId,
  threadId: ThreadId,
) =>
  queryOptions({
    queryKey: threadQueuedMessagesKey(userId, threadId),
    queryFn: async (): Promise<ReadonlyArray<ThreadQueuedMessage>> =>
      (
        await import("./message-queue-request-mutations.js")
      ).listQueuedThreadMessages(threadId),
    staleTime: 0,
  });

/** Reads the queue again, after the viewer sent, edited, or deleted. */
export const refreshThreadQueuedMessages = (
  queryClient: QueryClient,
  userId: UserId,
  threadId: ThreadId,
) =>
  queryClient.invalidateQueries({
    queryKey: threadQueuedMessagesKey(userId, threadId),
  });

export interface EditQueuedThreadMessageInput {
  readonly submissionId: string;
  readonly body: string;
  readonly idempotencyKey: string;
}

/**
 * Replaces a message the agent has not read. When the agent took it first,
 * the server restarts from it as an edit of a read message does, and says
 * so with `restarted`.
 */
export const editQueuedThreadMessageMutationOptions = (
  userId: UserId,
  threadId: ThreadId,
) =>
  mutationOptions({
    mutationKey: [
      ...threadKeys.all(userId),
      "edit-queued-message",
      threadId,
    ] as const,
    mutationFn: async (input: EditQueuedThreadMessageInput) =>
      (
        await import("./message-queue-request-mutations.js")
      ).editQueuedThreadMessage(threadId, input),
  });

/**
 * Deleting a message: one the agent has not read leaves the queue; one it
 * read takes the conversation back to just before it, sending nothing in its
 * place. `original` is the read message's text as Flue holds it.
 */
export type DeleteThreadMessageInput =
  | {
      readonly kind: "queued";
      readonly submissionId: string;
      readonly idempotencyKey: string;
    }
  | {
      readonly kind: "read";
      readonly entryId: string;
      readonly original: string;
      readonly idempotencyKey: string;
    };

export const deleteThreadMessageMutationOptions = (
  userId: UserId,
  threadId: ThreadId,
) =>
  mutationOptions({
    mutationKey: [
      ...threadKeys.all(userId),
      "delete-message",
      threadId,
    ] as const,
    mutationFn: async (input: DeleteThreadMessageInput) =>
      (
        await import("./message-queue-request-mutations.js")
      ).deleteThreadMessage(threadId, input),
  });

/**
 * The agent read a queued message before the change reached it; `entryId`
 * names the message in the history now.
 */
export const messageReadBeforeChange = (cause: unknown) =>
  cause instanceof ApiError && cause.code === "MESSAGE_READ"
    ? {
        entryId:
          typeof cause.data?.entryId === "string"
            ? cause.data.entryId
            : undefined,
      }
    : undefined;

/** The words for a refused queued edit or delete. */
export const messageQueueFailure = (cause: unknown) =>
  cause instanceof ApiError && cause.hasValidatedPayload
    ? cause.message
    : cause instanceof ApiError
      ? "Something went wrong. Try again."
      : "Check your connection.";
