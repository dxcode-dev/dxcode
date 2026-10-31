import { THREAD_SEARCH_QUERY_MAX_LENGTH } from "@dx/domain";
import { Schema } from "effect";
import { PageLimitQuerySchema } from "../http/page-limit-query.js";
import { errorResponse, successResponse } from "../http/response.js";

/** `GET /v1/thread-search`: the Thread search query language over Threads. */
export const SearchThreadsQuerySchema = Schema.Struct({
  q: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(THREAD_SEARCH_QUERY_MAX_LENGTH),
  ),
  cursor: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
  limit: Schema.optional(PageLimitQuerySchema),
});

export const SearchThreadsItemSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  projectId: Schema.String,
  projectName: Schema.String,
  ownerUserId: Schema.String,
  /** The owner's display name. */
  ownerName: Schema.String,
  parentThreadId: Schema.optional(Schema.String),
  color: Schema.String,
  archived: Schema.Boolean,
  pinned: Schema.Boolean,
  /** The requester's own Thread, snoozed until this time. */
  snoozedUntil: Schema.optional(Schema.String),
  visibility: Schema.Literals(["private", "workspace"]),
  state: Schema.Literals(["idle", "working"]),
  lastActivityAt: Schema.String,
  createdAt: Schema.String,
  /**
   * The Thread's Project was deleted and the owner kept the Thread, archived
   * and read-only. Only its owner finds it.
   */
  projectDeleted: Schema.optional(Schema.Literal(true)),
  /** The Project was deleted with its workspace. */
  workspaceDeleted: Schema.optional(Schema.Literal(true)),
  /** An excerpt of the newest message holding the first keyword. */
  matchedSearchText: Schema.optional(Schema.String),
});

export type SearchThreadsItem = typeof SearchThreadsItemSchema.Type;

export const SearchThreadsResponseSchema = successResponse(
  Schema.Struct({
    items: Schema.Array(SearchThreadsItemSchema),
    nextCursor: Schema.optional(Schema.String),
  }),
);

/** The message names what is wrong, such as an invalid filter value. */
export const SearchThreadsInvalidRequestResponseSchema = Schema.Struct({
  status: Schema.Literal("error"),
  data: Schema.Struct({
    code: Schema.Literal("INVALID_REQUEST"),
    message: Schema.String,
    requestId: Schema.String,
  }),
});

export const SearchThreadsUnavailableResponseSchema = errorResponse(
  "THREAD_SEARCH_UNAVAILABLE",
  "Thread search is unavailable.",
);

export type SearchThreadsResponse = typeof SearchThreadsResponseSchema.Encoded;
