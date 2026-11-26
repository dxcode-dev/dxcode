import { ThreadId } from "@dx/domain";
import { Schema } from "effect";
import { defineEndpoint } from "../http/endpoint.js";
import { errorResponse, successResponse } from "../http/response.js";
import { ThreadDataSchema } from "./thread-data.js";

export const PinThreadParamsSchema = Schema.Struct({ threadId: ThreadId });
export const PinThreadRequestSchema = Schema.Struct({ pinned: Schema.Boolean });
export const PinThreadResponseSchema = successResponse(ThreadDataSchema);
export const PinThreadInvalidRequestResponseSchema = errorResponse(
  "INVALID_REQUEST",
  "Request validation failed.",
);
export const PinThreadNotFoundResponseSchema = errorResponse(
  "THREAD_NOT_FOUND",
  "Thread was not found.",
);
export const PinThreadPersistenceUnavailableResponseSchema = errorResponse(
  "PERSISTENCE_UNAVAILABLE",
  "Persistence is temporarily unavailable.",
);

export const PinThreadEndpoint = defineEndpoint({
  id: "threads.pin",
  summary: "Pin or unpin a Thread",
  method: "PATCH",
  path: "/v1/threads/:threadId/pin",
  params: PinThreadParamsSchema,
  body: PinThreadRequestSchema,
  success: PinThreadResponseSchema,
  refusals: [
    { status: 400, schema: PinThreadInvalidRequestResponseSchema },
    { status: 404, schema: PinThreadNotFoundResponseSchema },
    { status: 503, schema: PinThreadPersistenceUnavailableResponseSchema },
  ],
});
