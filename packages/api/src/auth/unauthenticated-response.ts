import { errorResponse } from "../http/response.js";

export const UnauthenticatedResponseSchema = errorResponse(
  "UNAUTHENTICATED",
  "Authentication required.",
);

export type UnauthenticatedResponse = typeof UnauthenticatedResponseSchema.Type;
