import { ThreadId } from "@dx/domain";
import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";

/** The longest draft a person can keep in one Thread's composer. */
export const THREAD_DRAFT_MAX_LENGTH = 65_536;

export const ThreadDraftText = Schema.String.check(
  Schema.isMaxLength(THREAD_DRAFT_MAX_LENGTH),
);

export const ThreadDraftParamsSchema = Schema.Struct({ threadId: ThreadId });

/**
 * `GET /v1/threads/:threadId/draft`, and `PUT` with `{ text }`: the signed-in
 * person's unsent message in this Thread's composer, the same on each of their
 * devices. The last write wins; `""` means no draft.
 */
export const ThreadDraftResponseSchema = successResponse(
  Schema.Struct({ text: ThreadDraftText }),
);
export type ThreadDraftResponse = typeof ThreadDraftResponseSchema.Type;

export const UpdateThreadDraftRequestSchema = Schema.Struct({
  text: ThreadDraftText,
});

export const ThreadDraftErrorResponseSchema = Schema.Union([
  errorResponse("INVALID_REQUEST", "Request validation failed."),
  errorResponse("THREAD_NOT_FOUND", "Thread was not found."),
  errorResponse(
    "PERSISTENCE_UNAVAILABLE",
    "Persistence is temporarily unavailable.",
  ),
]);
