import { ThreadId } from "@dx/domain";
import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";

export const DeleteThreadParamsSchema = Schema.Struct({ threadId: ThreadId });

/**
 * A deleted Thread. Its ID stays reserved. `cleanup` reports whether its
 * history, sandbox, and stored files are already gone (`complete`) or still
 * being removed (`pending`), which the server retries until done.
 */
export const DeleteThreadResponseSchema = successResponse(
  Schema.Struct({
    threadId: ThreadId,
    deletedAt: Schema.String,
    cleanup: Schema.Literals(["complete", "pending"]),
  }),
);
export const DeleteThreadInvalidRequestResponseSchema = errorResponse(
  "INVALID_REQUEST",
  "Request validation failed.",
);
export const DeleteThreadNotFoundResponseSchema = errorResponse(
  "THREAD_NOT_FOUND",
  "Thread was not found.",
);
export const DeleteThreadPersistenceUnavailableResponseSchema = errorResponse(
  "PERSISTENCE_UNAVAILABLE",
  "Persistence is temporarily unavailable.",
);
/** Any request for a Thread its owner deleted. */
export const ThreadDeletedResponseSchema = errorResponse(
  "THREAD_DELETED",
  "This Thread was deleted.",
);
/** A create that names the ID of a deleted Thread. */
export const ThreadIdUnavailableResponseSchema = errorResponse(
  "THREAD_ID_UNAVAILABLE",
  "This Thread ID belonged to a deleted Thread and cannot be reused.",
);

export type DeleteThreadResponse = typeof DeleteThreadResponseSchema.Encoded;
export type ThreadDeletedResponse = typeof ThreadDeletedResponseSchema.Type;
export type ThreadIdUnavailableResponse =
  typeof ThreadIdUnavailableResponseSchema.Type;
