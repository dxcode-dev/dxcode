import { ThreadColor, ThreadId, ThreadTitle } from "@dx/domain";
import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";
import { ThreadDataSchema } from "./thread-data.js";

export const UpdateThreadParamsSchema = Schema.Struct({ threadId: ThreadId });
/** Rename or recolor a Thread; `color: null` returns it to auto. */
export const UpdateThreadRequestSchema = Schema.Struct({
  title: Schema.optional(ThreadTitle),
  color: Schema.optional(Schema.NullOr(ThreadColor)),
});
export type UpdateThreadRequest = typeof UpdateThreadRequestSchema.Type;
export const UpdateThreadResponseSchema = successResponse(ThreadDataSchema);
export const UpdateThreadInvalidRequestResponseSchema = errorResponse(
  "INVALID_REQUEST",
  "Request validation failed.",
);
export const UpdateThreadNotFoundResponseSchema = errorResponse(
  "THREAD_NOT_FOUND",
  "Thread was not found.",
);
export const UpdateThreadPersistenceUnavailableResponseSchema = errorResponse(
  "PERSISTENCE_UNAVAILABLE",
  "Persistence is temporarily unavailable.",
);
