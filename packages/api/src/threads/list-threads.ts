import { ModeId, ModelId, PageCursor, ProjectId, ThreadId } from "@dx/domain";
import { Schema } from "effect";
import { PageLimitQuerySchema } from "../http/page-limit-query.js";
import { errorResponse, successResponse } from "../http/response.js";
import { ThreadChangesSummarySchema } from "./changes.js";
import { ThreadDataSchema } from "./thread-data.js";

export const ThreadChildActivitySchema = Schema.Struct({
  working: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  unread: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  failed: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export type ThreadChildActivity = typeof ThreadChildActivitySchema.Type;

export const ThreadListItemSchema = Schema.Struct({
  ...ThreadDataSchema.fields,
  mode: Schema.Union([ModeId, ModelId]),
  changes: Schema.optional(ThreadChangesSummarySchema),
  /**
   * Roots only: the child Threads listed in this one's family, at any depth;
   * absent when none. The roots list carries those listed directly under it.
   */
  childCount: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  /**
   * Child Threads only: the Threads below this one that list under it rather
   * than under the root, those it started and theirs. Absent when none.
   */
  startedCount: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  /**
   * The agent finished a turn the requester has not seen: it settled after
   * they last opened the Thread. Absent when seen.
   */
  unread: Schema.optional(Schema.Literal(true)),
  /** The latest turn ended in an error. Absent when it did not. */
  turnFailed: Schema.optional(Schema.Literal(true)),
  /**
   * Roots with `childCount` only: how many of those children are working,
   * unread for the requester, and ended their latest turn in an error.
   */
  childActivity: Schema.optional(ThreadChildActivitySchema),
});

export type ThreadListItem = typeof ThreadListItemSchema.Type;

export const ListThreadsQuerySchema = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  lifecycleState: Schema.optional(Schema.Literals(["active", "archived"])),
  cursor: Schema.optional(PageCursor),
  limit: Schema.optional(PageLimitQuerySchema),
  /**
   * `true` lists only Threads not listed under a parent, each with its
   * `childCount`, and the response's `children` lists their children. Not
   * combined with `parentThreadId`.
   */
  roots: Schema.optional(Schema.Literal("true")),
  /** Lists the child Threads listed directly under one root. */
  parentThreadId: Schema.optional(ThreadId),
}).check(
  Schema.makeFilter((query) =>
    query.roots !== undefined && query.parentThreadId !== undefined
      ? { path: ["roots"], issue: "Use roots or parentThreadId, not both." }
      : undefined,
  ),
);

export const ListThreadsResponseSchema = successResponse(
  Schema.Struct({
    items: Schema.Array(ThreadListItemSchema),
    /**
     * Roots only: the child Threads listed directly under this page's roots,
     * up to 100 per root, most recent activity first: those the root started,
     * and those whose starter does not list with them. A root with more pages
     * the rest with `parentThreadId`.
     */
    children: Schema.optional(Schema.Array(ThreadListItemSchema)),
    nextCursor: Schema.optional(PageCursor),
  }),
);

export const ListThreadsInvalidRequestResponseSchema = errorResponse(
  "INVALID_REQUEST",
  "Request validation failed.",
);

export const ListThreadsPersistenceUnavailableResponseSchema = errorResponse(
  "PERSISTENCE_UNAVAILABLE",
  "Persistence is temporarily unavailable.",
);

export type ListThreadsResponse = typeof ListThreadsResponseSchema.Encoded;
export type ListThreadsInvalidRequestResponse =
  typeof ListThreadsInvalidRequestResponseSchema.Type;
export type ListThreadsPersistenceUnavailableResponse =
  typeof ListThreadsPersistenceUnavailableResponseSchema.Type;

/** Active Threads other workspace members shared with the requester. */
export const ListSharedThreadsResponseSchema = successResponse(
  Schema.Struct({ items: Schema.Array(ThreadListItemSchema) }),
);
