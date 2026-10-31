import { ThreadId } from "@dx/domain";
import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";
import { ThreadListItemSchema } from "./list-threads.js";

export const GetThreadTreeParamsSchema = Schema.Struct({
  threadId: ThreadId,
});

/** The most family members one tree response lists. */
export const THREAD_TREE_MAX_ITEMS = 500;

/**
 * The Thread's family as the requester may read it: its root and every child
 * of that root, active and archived, oldest first. A workspace member of a
 * shared family gets only the members shared with them, each with `access`
 * and `projectName` as the shared list returns them; the root can be absent.
 * Each child names the member that started it in `startedByThreadId`; a child
 * whose starter is absent sits under the root. Rows carry no Changes totals
 * or child counts.
 */
export const GetThreadTreeResponseSchema = successResponse(
  Schema.Struct({
    rootThreadId: ThreadId,
    items: Schema.Array(ThreadListItemSchema).check(
      Schema.isMaxLength(THREAD_TREE_MAX_ITEMS),
    ),
    /** The family has more members than `items` lists: the newest are left out. */
    truncated: Schema.optional(Schema.Literal(true)),
  }),
);

export const GetThreadTreeInvalidRequestResponseSchema = errorResponse(
  "INVALID_REQUEST",
  "Request validation failed.",
);

export const GetThreadTreeNotFoundResponseSchema = errorResponse(
  "THREAD_NOT_FOUND",
  "Thread not found.",
);

export const GetThreadTreePersistenceUnavailableResponseSchema = errorResponse(
  "PERSISTENCE_UNAVAILABLE",
  "Persistence is temporarily unavailable.",
);

export type GetThreadTreeResponse = typeof GetThreadTreeResponseSchema.Encoded;
