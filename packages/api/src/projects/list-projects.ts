import { PageCursor } from "@dx/domain";
import { Schema } from "effect";
import { PageLimitQuerySchema } from "../http/page-limit-query.js";
import { errorResponse, successResponse } from "../http/response.js";
import { ProjectDataSchema } from "./project-data.js";

export const ListProjectsQuerySchema = Schema.Struct({
  cursor: Schema.optional(PageCursor),
  limit: Schema.optional(PageLimitQuerySchema),
});

export const ListProjectsResponseSchema = successResponse(
  Schema.Struct({
    items: Schema.Array(ProjectDataSchema),
    nextCursor: Schema.optional(PageCursor),
  }),
);

export const ListProjectsInvalidRequestResponseSchema = errorResponse(
  "INVALID_REQUEST",
  "Request validation failed.",
);

export const ListProjectsPersistenceUnavailableResponseSchema = errorResponse(
  "PERSISTENCE_UNAVAILABLE",
  "Persistence is temporarily unavailable.",
);

export type ListProjectsResponse = typeof ListProjectsResponseSchema.Encoded;
export type ListProjectsInvalidRequestResponse =
  typeof ListProjectsInvalidRequestResponseSchema.Type;
export type ListProjectsPersistenceUnavailableResponse =
  typeof ListProjectsPersistenceUnavailableResponseSchema.Type;
