import { ThreadId } from "@dx/domain";
import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";

export const MarkThreadSeenParamsSchema = Schema.Struct({
  threadId: ThreadId,
});

/**
 * `POST /v1/threads/:threadId/seen`: the requester opened the Thread, so
 * every turn it has finished is seen and its row is no longer unread.
 */
export const MarkThreadSeenResponseSchema = successResponse(
  Schema.Struct({ threadId: ThreadId }),
);

export const MarkThreadSeenInvalidRequestResponseSchema = errorResponse(
  "INVALID_REQUEST",
  "Request validation failed.",
);

export const MarkThreadSeenNotFoundResponseSchema = errorResponse(
  "THREAD_NOT_FOUND",
  "Thread not found.",
);

export const MarkThreadSeenPersistenceUnavailableResponseSchema = errorResponse(
  "PERSISTENCE_UNAVAILABLE",
  "Persistence is temporarily unavailable.",
);
