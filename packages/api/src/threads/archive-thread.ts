import { ThreadId } from "@dx/domain";
import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";
import { ThreadDataSchema } from "./thread-data.js";

export const ArchiveThreadParamsSchema = Schema.Struct({ threadId: ThreadId });
export const ArchiveThreadRequestSchema = Schema.Struct({
  archived: Schema.Boolean,
  /** Also archive or restore the Thread's child Threads. */
  includeChildren: Schema.optional(Schema.Boolean),
  /**
   * With `includeChildren`, only these children: an Undo restores exactly
   * the ones its archive changed.
   */
  childThreadIds: Schema.optional(
    Schema.Array(ThreadId).check(Schema.isMaxLength(1_000)),
  ),
  /**
   * `ship`: archived from the outcome of the Thread's Ship run, so its work
   * counts as shipped. Only with `archived: true`.
   */
  reason: Schema.optional(Schema.Literal("ship")),
});
export const ArchiveThreadResponseSchema = Schema.Struct({
  ...successResponse(ThreadDataSchema).fields,
  /** With `includeChildren`: the children this request changed. */
  changedChildThreadIds: Schema.optional(Schema.Array(ThreadId)),
  /**
   * The Thread is archived, but its Orb (or a child's) is still stopping:
   * it couldn't be stopped yet without losing unsaved work, and its
   * provider finishes the stop on its own.
   */
  orbStopping: Schema.optional(Schema.Literal(true)),
});
export const ArchiveThreadInvalidRequestResponseSchema = errorResponse(
  "INVALID_REQUEST",
  "Request validation failed.",
);
export const ArchiveThreadNotFoundResponseSchema = errorResponse(
  "THREAD_NOT_FOUND",
  "Thread was not found.",
);
export const ArchiveThreadPersistenceUnavailableResponseSchema = errorResponse(
  "PERSISTENCE_UNAVAILABLE",
  "Persistence is temporarily unavailable.",
);
/** Unarchiving a Thread whose Project, or its workspace, was deleted. */
export const ArchiveThreadProjectDeletedResponseSchema = errorResponse(
  "THREAD_PROJECT_DELETED",
  "This thread's project was deleted, so the thread stays archived.",
);
export const ThreadArchivedResponseSchema = errorResponse(
  "THREAD_ARCHIVED",
  "Thread is archived. Unarchive it before continuing.",
);

export type ArchiveThreadResponse = typeof ArchiveThreadResponseSchema.Encoded;
export type ArchiveThreadInvalidRequestResponse =
  typeof ArchiveThreadInvalidRequestResponseSchema.Type;
export type ArchiveThreadNotFoundResponse =
  typeof ArchiveThreadNotFoundResponseSchema.Type;
export type ArchiveThreadPersistenceUnavailableResponse =
  typeof ArchiveThreadPersistenceUnavailableResponseSchema.Type;
export type ThreadArchivedResponse = typeof ThreadArchivedResponseSchema.Type;
