import { ModelId, SpaceAgentModel, ThinkingLevel } from "@dx/domain";
import { Schema } from "effect";
import { successResponse } from "../http/response.js";

/**
 * Where a new Space's main Thread would run with the person's current
 * settings. dx picks it once, when the Space is created, and the Space keeps
 * it:
 *
 * - `claude-code`: Claude Code on the person's Claude Pro/Max plan, in the
 *   Space's executor; the model is one Claude Code serves.
 * - `model-routing`: the model through Model Routing, on dx's own agent.
 * - `unavailable`: neither serves the model, so a Space cannot be created
 *   until the person picks another model or connects a provider.
 */
export const SpaceAgentRouteSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("claude-code"),
    model: ModelId,
    modelName: Schema.String,
    thinking: ThinkingLevel,
    /** The plan's name, such as "Claude Pro/Max". */
    connectionName: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("model-routing"),
    model: ModelId,
    modelName: Schema.String,
    thinking: ThinkingLevel,
    /** The Model Routing connection that serves the model. */
    connectionName: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("unavailable"),
    model: ModelId,
    modelName: Schema.String,
    thinking: ThinkingLevel,
    /** What to do, in a sentence the person can act on. */
    message: Schema.String,
  }),
]);

export type SpaceAgentRoute = typeof SpaceAgentRouteSchema.Type;

/** `GET /v1/settings/personal/space-agent-model`. */
export const GetSpaceAgentModelResponseSchema = successResponse(
  Schema.Struct({
    /** The person's pin; absent means Auto (Claude Opus 5.5, medium). */
    pin: Schema.optional(SpaceAgentModel),
    route: SpaceAgentRouteSchema,
  }),
);

export type GetSpaceAgentModelResponse =
  typeof GetSpaceAgentModelResponseSchema.Encoded;

/** `PUT /v1/settings/personal/space-agent-model`: `null` returns to Auto. */
export const UpdateSpaceAgentModelRequestSchema = Schema.Struct({
  pin: Schema.NullOr(SpaceAgentModel),
});

export type UpdateSpaceAgentModelRequest =
  typeof UpdateSpaceAgentModelRequestSchema.Encoded;
