import { ThreadId } from "@dx/domain";
import { Schema } from "effect";
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
