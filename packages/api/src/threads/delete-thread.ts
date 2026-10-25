import { ThreadId } from "@dx/domain";
import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";

export const DeleteThreadParamsSchema = Schema.Struct({ threadId: ThreadId });
export const DeleteThreadQuerySchema = Schema.Struct({
  /**
   * Also delete the child Threads listed under it: those sharing its
   * lifecycle state, unpinned, as the sidebar counts them. Up to
   * `DELETE_THREAD_MAX_CHILDREN`; the rest become top-level Threads.
   */
  includeChildren: Schema.optional(Schema.Literal("true")),
});

/** The most child Threads one request deletes with their parent. */
export const DELETE_THREAD_MAX_CHILDREN = 50;

/**
 * A deleted Thread. Its ID stays reserved. `cleanup` reports whether its
 * history, sandbox, and stored files are already gone (`complete`) or still
 * being removed (`pending`), which the server retries until done. With
 * children, `cleanup` covers them too.
 */
export const DeleteThreadResponseSchema = successResponse(
  Schema.Struct({
    threadId: ThreadId,
    deletedAt: Schema.String,
    cleanup: Schema.Literals(["complete", "pending"]),
    /** With `includeChildren`: the children deleted with it. */
    deletedChildThreadIds: Schema.optional(Schema.Array(ThreadId)),
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
