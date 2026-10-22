import { ThreadId, Timestamp } from "@dx/domain";
import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";
import { ThreadDataSchema } from "./thread-data.js";

export const SnoozeThreadParamsSchema = Schema.Struct({ threadId: ThreadId });
/** A future wake time snoozes the Thread; `null` wakes it. */
export const SnoozeThreadRequestSchema = Schema.Struct({
  snoozedUntil: Schema.NullOr(Timestamp),
});
export type SnoozeThreadRequest = typeof SnoozeThreadRequestSchema.Type;
export const SnoozeThreadResponseSchema = successResponse(ThreadDataSchema);
export const SnoozeThreadInvalidRequestResponseSchema = errorResponse(
  "INVALID_REQUEST",
  "Request validation failed.",
);
export const SnoozeThreadNotFoundResponseSchema = errorResponse(
  "THREAD_NOT_FOUND",
  "Thread was not found.",
);
/** Archived and child Threads do not snooze; a child follows its parent. */
export const SnoozeThreadUnavailableResponseSchema = errorResponse(
  "THREAD_SNOOZE_UNAVAILABLE",
  "Only active Threads that were not started by another Thread can be snoozed.",
);
export const SnoozeThreadPersistenceUnavailableResponseSchema = errorResponse(
  "PERSISTENCE_UNAVAILABLE",
  "Persistence is temporarily unavailable.",
);
export const SnoozeThreadInvalidTimeResponseSchema = errorResponse(
  "INVALID_SNOOZE_TIME",
  "Choose a wake time in the future, within a year.",
);
