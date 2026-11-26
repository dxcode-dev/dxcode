import { ThreadId } from "@dx/domain";
import { Schema } from "effect";
import { defineEndpoint } from "../http/endpoint.js";
import {
  EditThreadMessageErrorResponseSchema,
  EditThreadMessageRequestSchema,
  EditThreadMessageResponseSchema,
  ThreadMessageEntryIdSchema,
} from "./edit-message.js";
import { ThreadAccessRefusals } from "./thread-access-refusals.js";

/** The message edit endpoint, apart from `edit-message.ts`'s schemas. */

export const EditThreadMessageParamsSchema = Schema.Struct({
  threadId: ThreadId,
  entryId: ThreadMessageEntryIdSchema,
});

export const EditThreadMessageEndpoint = defineEndpoint({
  id: "threads.messages.edit",
  summary: "Edit a message the person sent",
  method: "POST",
  path: "/v1/threads/:threadId/messages/:entryId/edit",
  params: EditThreadMessageParamsSchema,
  body: EditThreadMessageRequestSchema,
  success: EditThreadMessageResponseSchema,
  // 400, 403, 404, 409, 502, or 503 by its code.
  refusals: [
    ...ThreadAccessRefusals,
    // One union of codes, each sent with its own status.
    { status: 400, schema: EditThreadMessageErrorResponseSchema },
    { status: 403, schema: EditThreadMessageErrorResponseSchema },
    { status: 404, schema: EditThreadMessageErrorResponseSchema },
    { status: 409, schema: EditThreadMessageErrorResponseSchema },
    { status: 502, schema: EditThreadMessageErrorResponseSchema },
    { status: 503, schema: EditThreadMessageErrorResponseSchema },
  ],
});
