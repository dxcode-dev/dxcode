import { errorResponse } from "./response.js";

export const InternalServerErrorResponseSchema = errorResponse(
  "INTERNAL_SERVER_ERROR",
  "An unexpected error occurred.",
);

export type InternalServerErrorResponse =
  typeof InternalServerErrorResponseSchema.Type;
