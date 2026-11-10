import {
  EditThreadMessageErrorResponseSchema,
  EditThreadMessageResponseSchema,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { request } from "../../shared/api/client.js";
import type { EditThreadMessageInput } from "./message-edit-mutations.js";

/**
 * The edit request, loaded when someone sends an edit rather than with the
 * Thread page, with the route's own error answers.
 */
export const editThreadMessage = async (
  threadId: ThreadId,
  { entryId, original, body, idempotencyKey }: EditThreadMessageInput,
) =>
  (
    await request(
      `/v1/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(entryId)}/edit`,
      EditThreadMessageResponseSchema,
      {
        method: "POST",
        body: JSON.stringify({ original, body, idempotencyKey }),
      },
      EditThreadMessageErrorResponseSchema,
    )
  ).data;
