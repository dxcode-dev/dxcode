import { ThreadId } from "@dx/domain";
import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";

/**
 * What a Thread waits on its owner for: an answer or an approval the agent
 * asked for with `request_attention`, or a failed turn.
 */
export const NeedsYouKindSchema = Schema.Literals([
  "question",
  "approval",
  "failed",
]);

export type NeedsYouKind = typeof NeedsYouKindSchema.Type;

export const NeedsYouItemSchema = Schema.Struct({
  threadId: ThreadId,
  threadTitle: Schema.String.check(Schema.isMaxLength(256)),
  projectName: Schema.String.check(Schema.isMaxLength(256)),
  kind: NeedsYouKindSchema,
  /** The agent's one-line ask; absent for a failed turn. */
  summary: Schema.optional(Schema.String.check(Schema.isMaxLength(300))),
  /** A link the ask points at, such as a pull request. */
  url: Schema.optional(Schema.String.check(Schema.isMaxLength(2_048))),
  requestedAt: Schema.String,
});

export type NeedsYouItem = typeof NeedsYouItemSchema.Type;

/**
 * `GET /v1/needs-you` and `DELETE /v1/needs-you/:threadId`: the signed-in
 * person's Threads that wait on them, newest first.
 */
export const NeedsYouResponseSchema = successResponse(
  Schema.Struct({ items: Schema.Array(NeedsYouItemSchema) }),
);

export type NeedsYouData = (typeof NeedsYouResponseSchema.Type)["data"];

export const NeedsYouErrorResponseSchema = Schema.Union([
  errorResponse("INVALID_REQUEST", "Request validation failed."),
  errorResponse(
    "PERSISTENCE_UNAVAILABLE",
    "Persistence is temporarily unavailable.",
  ),
]);
