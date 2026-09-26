import { errorResponse } from "../http/response.js";

export const ThreadNotFoundResponseSchema = errorResponse(
  "THREAD_NOT_FOUND",
  "Thread not found.",
);

export type ThreadNotFoundResponse = typeof ThreadNotFoundResponseSchema.Type;
