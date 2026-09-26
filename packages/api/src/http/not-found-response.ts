import { errorResponse } from "./response.js";

export const NotFoundResponseSchema = errorResponse(
  "NOT_FOUND",
  "Route not found.",
);

export type NotFoundResponse = typeof NotFoundResponseSchema.Type;
