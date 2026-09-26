import { errorResponse } from "../http/response.js";

export const ForbiddenResponseSchema = errorResponse(
  "FORBIDDEN",
  "The credential does not grant access to this resource.",
);

export type ForbiddenResponse = typeof ForbiddenResponseSchema.Type;
