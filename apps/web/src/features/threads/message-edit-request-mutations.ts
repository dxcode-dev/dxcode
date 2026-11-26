import { EditThreadMessageEndpoint } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { dxClient } from "../../shared/api/client.js";
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
    await dxClient.call(EditThreadMessageEndpoint, {
      params: { threadId, entryId },
      body: { original, body, idempotencyKey },
    })
  ).data;
