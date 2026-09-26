import { ThreadId } from "@dx/domain";
import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";
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
