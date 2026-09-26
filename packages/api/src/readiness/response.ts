import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";

export const ReadinessResponseSchema = successResponse(
  Schema.Struct({ state: Schema.Literal("ready") }),
);

export type ReadinessResponse = typeof ReadinessResponseSchema.Type;

export const ServiceNotReadyResponseSchema = errorResponse(
  "SERVICE_NOT_READY",
  "Required runtime configuration is missing or invalid.",
);

export type ServiceNotReadyResponse = typeof ServiceNotReadyResponseSchema.Type;
