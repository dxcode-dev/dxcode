import { ThreadId } from "@dx/domain";
import { Schema } from "effect";
import { defineEndpoint } from "../http/endpoint.js";
import { errorResponse, successResponse } from "../http/response.js";
import { ThreadExecutionWorkspaceDataSchema } from "./thread-data.js";

export const GetThreadReadinessParamsSchema = Schema.Struct({
  threadId: ThreadId,
});

export const GetThreadReadinessResponseSchema = successResponse(
  ThreadExecutionWorkspaceDataSchema,
);

export const GetThreadReadinessInvalidRequestResponseSchema = errorResponse(
  "INVALID_REQUEST",
  "Request validation failed.",
);

export const GetThreadReadinessNotFoundResponseSchema = errorResponse(
  "THREAD_NOT_FOUND",
  "Thread not found.",
);

export const GetThreadReadinessPersistenceUnavailableResponseSchema =
  errorResponse(
    "PERSISTENCE_UNAVAILABLE",
    "Persistence is temporarily unavailable.",
  );

export type GetThreadReadinessResponse =
  typeof GetThreadReadinessResponseSchema.Encoded;

export const GetThreadReadinessEndpoint = defineEndpoint({
  id: "threads.getReadiness",
  method: "GET",
  path: "/v1/threads/:threadId/readiness",
  params: GetThreadReadinessParamsSchema,
  success: GetThreadReadinessResponseSchema,
  refusals: [
    { status: 400, schema: GetThreadReadinessInvalidRequestResponseSchema },
    { status: 404, schema: GetThreadReadinessNotFoundResponseSchema },
    {
      status: 503,
      schema: GetThreadReadinessPersistenceUnavailableResponseSchema,
    },
  ],
});
