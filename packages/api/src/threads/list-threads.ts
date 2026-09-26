import { ModeId, ModelId, PageCursor, ProjectId } from "@dx/domain";
import { Schema } from "effect";
import { PageLimitQuerySchema } from "../http/page-limit-query.js";
import { errorResponse, successResponse } from "../http/response.js";
import { ThreadChangesSummarySchema } from "./changes.js";
import { ThreadDataSchema } from "./thread-data.js";

export const ThreadListItemSchema = Schema.Struct({
  ...ThreadDataSchema.fields,
  mode: Schema.Union([ModeId, ModelId]),
  changes: Schema.optional(ThreadChangesSummarySchema),
});

export type ThreadListItem = typeof ThreadListItemSchema.Type;

export const ListThreadsQuerySchema = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  lifecycleState: Schema.optional(Schema.Literals(["active", "archived"])),
  cursor: Schema.optional(PageCursor),
  limit: Schema.optional(PageLimitQuerySchema),
});

export const ListThreadsResponseSchema = successResponse(
  Schema.Struct({
    items: Schema.Array(ThreadListItemSchema),
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
