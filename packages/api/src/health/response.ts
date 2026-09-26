import { Schema } from "effect";
import { successResponse } from "../http/response.js";

export const HealthResponseSchema = successResponse(
  Schema.Struct({ state: Schema.Literal("live") }),
);

export type HealthResponse = typeof HealthResponseSchema.Type;
