import { ThreadId } from "@dx/domain";
import { Schema } from "effect";
import { defineEndpoint } from "../http/endpoint.js";
import {
  ThreadQuickActionsErrorResponseSchema,
  ThreadQuickActionsResponseSchema,
} from "./reply-offers.js";
import { ThreadAccessRefusals } from "./thread-access-refusals.js";

/** The composer quick actions endpoint, apart from `reply-offers.ts`. */

export const ThreadQuickActionsParamsSchema = Schema.Struct({
  threadId: ThreadId,
});
/** The agent message on the person's screen. */
export const ThreadQuickActionsQuerySchema = Schema.Struct({
  messageId: Schema.optional(Schema.String),
});

export const GetThreadQuickActionsEndpoint = defineEndpoint({
  id: "threads.quickActions.get",
  summary: "Read a Thread's quick actions",
  method: "GET",
  path: "/v1/threads/:threadId/quick-actions",
  params: ThreadQuickActionsParamsSchema,
  query: ThreadQuickActionsQuerySchema,
  success: ThreadQuickActionsResponseSchema,
  // One union of codes, each sent with its own status.
  refusals: [
    ...ThreadAccessRefusals,
    { status: 403, schema: ThreadQuickActionsErrorResponseSchema },
    { status: 409, schema: ThreadQuickActionsErrorResponseSchema },
  ],
});
