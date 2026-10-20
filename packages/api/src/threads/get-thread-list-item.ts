import { ThreadId } from "@dx/domain";
import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";
import { ThreadListItemSchema } from "./list-threads.js";

export const GetThreadListItemParamsSchema = Schema.Struct({
  threadId: ThreadId,
});

/**
 * One Thread's sidebar row, exactly as the requester's Thread lists return
 * it: the owner's list row, or for a member the shared list's row.
 * `childCount` is present when children list under it, which only a roots
 * list's `items` show.
 */
export const GetThreadListItemResponseSchema =
  successResponse(ThreadListItemSchema);

export const GetThreadListItemInvalidRequestResponseSchema = errorResponse(
  "INVALID_REQUEST",
  "Request validation failed.",
);

export const GetThreadListItemNotFoundResponseSchema = errorResponse(
  "THREAD_NOT_FOUND",
  "Thread not found.",
);

export const GetThreadListItemPersistenceUnavailableResponseSchema =
  errorResponse(
    "PERSISTENCE_UNAVAILABLE",
    "Persistence is temporarily unavailable.",
  );

export type GetThreadListItemResponse =
  typeof GetThreadListItemResponseSchema.Encoded;
