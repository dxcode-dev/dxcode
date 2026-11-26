import { ThreadId } from "@dx/domain";
import { Schema } from "effect";
import { defineEndpoint } from "../http/endpoint.js";
import { errorResponse, successResponse } from "../http/response.js";
import { ThreadDeletedResponseSchema } from "./delete-thread.js";
import { ThreadDetailDataSchema } from "./thread-data.js";

export const GetThreadParamsSchema = Schema.Struct({
  threadId: ThreadId,
});

export const GetThreadResponseSchema = successResponse(ThreadDetailDataSchema);

export const GetThreadInvalidRequestResponseSchema = errorResponse(
  "INVALID_REQUEST",
  "Request validation failed.",
);

export const GetThreadNotFoundResponseSchema = errorResponse(
  "THREAD_NOT_FOUND",
  "Thread not found.",
);

export const GetThreadPersistenceUnavailableResponseSchema = errorResponse(
  "PERSISTENCE_UNAVAILABLE",
  "Persistence is temporarily unavailable.",
);

export type GetThreadResponse = typeof GetThreadResponseSchema.Encoded;
export type GetThreadInvalidRequestResponse =
  typeof GetThreadInvalidRequestResponseSchema.Type;
export type GetThreadNotFoundResponse =
  typeof GetThreadNotFoundResponseSchema.Type;
export type GetThreadPersistenceUnavailableResponse =
  typeof GetThreadPersistenceUnavailableResponseSchema.Type;

export const GetThreadEndpoint = defineEndpoint({
  id: "threads.get",
  method: "GET",
  path: "/v1/threads/:threadId",
  params: GetThreadParamsSchema,
  success: GetThreadResponseSchema,
  refusals: [
    { status: 400, schema: GetThreadInvalidRequestResponseSchema },
    { status: 404, schema: GetThreadNotFoundResponseSchema },
    { status: 503, schema: GetThreadPersistenceUnavailableResponseSchema },
    { status: 410, schema: ThreadDeletedResponseSchema },
  ],
});
