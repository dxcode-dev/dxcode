import { ThreadColor, ThreadId, ThreadModelPin, ThreadTitle } from "@dx/domain";
import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";
import { ThreadDataSchema } from "./thread-data.js";

export const UpdateThreadParamsSchema = Schema.Struct({ threadId: ThreadId });
/**
 * Rename or recolor a Thread; `color: null` returns it to auto. `selection`
 * changes the model and effort the Thread runs on from its next submitted
 * message; a turn already running keeps its model.
 */
export const UpdateThreadRequestSchema = Schema.Struct({
  title: Schema.optional(ThreadTitle),
  color: Schema.optional(Schema.NullOr(ThreadColor)),
  selection: Schema.optional(ThreadModelPin),
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
/** No connection of the owner's serves the requested model. */
export const UpdateThreadModelNotServedResponseSchema = errorResponse(
  "MODEL_NOT_SERVED",
  "No connection serves that model.",
);
/** A Space's model is set in Settings, not on the Space itself. */
export const UpdateThreadModelLockedResponseSchema = errorResponse(
  "THREAD_MODEL_LOCKED",
  "This Thread's model cannot be changed.",
);
export const UpdateThreadPersistenceUnavailableResponseSchema = errorResponse(
  "PERSISTENCE_UNAVAILABLE",
  "Persistence is temporarily unavailable.",
);
