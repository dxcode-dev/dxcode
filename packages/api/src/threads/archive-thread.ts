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
});
export const ArchiveThreadResponseSchema = Schema.Struct({
  ...successResponse(ThreadDataSchema).fields,
  /** With `includeChildren`: the children this request changed. */
  changedChildThreadIds: Schema.optional(Schema.Array(ThreadId)),
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
export const ArchiveThreadExecutionUnavailableResponseSchema = errorResponse(
  "THREAD_ARCHIVE_UNAVAILABLE",
  "The Thread was archived, but its sandbox could not be stopped.",
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
export type ArchiveThreadExecutionUnavailableResponse =
  typeof ArchiveThreadExecutionUnavailableResponseSchema.Type;
export type ThreadArchivedResponse = typeof ThreadArchivedResponseSchema.Type;
