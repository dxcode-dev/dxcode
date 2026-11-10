import type { EditThreadMessageRequest } from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import { mutationOptions } from "@tanstack/react-query";
import { ApiError } from "../../shared/api/client.js";
import { threadKeys } from "./thread-queries.js";

export interface EditThreadMessageInput extends EditThreadMessageRequest {
  /** Flue's id of the user message, as its history names it (`entry_…`). */
  readonly entryId: string;
}

/**
 * Replaces one of the person's earlier messages: the server stops the agent,
 * takes the conversation back to just before the message, and sends `body`
 * in its place. Flue then reloads the history on its own. The request and
 * its schemas load when an edit is sent, not with the Thread page.
 */
export const editThreadMessageMutationOptions = (
  userId: UserId,
  threadId: ThreadId,
) =>
  mutationOptions({
    mutationKey: [...threadKeys.all(userId), "edit-message", threadId] as const,
    mutationFn: async (input: EditThreadMessageInput) =>
      (await import("./message-edit-request-mutations.js")).editThreadMessage(
        threadId,
        input,
      ),
  });

/**
 * Why an edit request failed: `notSent` when the server kept the original
 * message, and the words to show for it.
 */
export const editThreadMessageFailure = (cause: unknown) => ({
  notSent: cause instanceof ApiError && cause.code === "EDIT_NOT_SENT",
  message:
    cause instanceof ApiError && cause.hasValidatedPayload
      ? cause.message
      : cause instanceof ApiError
        ? "Something went wrong. Try again."
        : "Check your connection.",
});
