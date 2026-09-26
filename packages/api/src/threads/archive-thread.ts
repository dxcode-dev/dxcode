import { ThreadId } from "@dx/domain";
import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";
import { ThreadDataSchema } from "./thread-data.js";

export const ArchiveThreadParamsSchema = Schema.Struct({ threadId: ThreadId });
export const ArchiveThreadRequestSchema = Schema.Struct({
  archived: Schema.Boolean,
});
export const ArchiveThreadResponseSchema = successResponse(ThreadDataSchema);
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
