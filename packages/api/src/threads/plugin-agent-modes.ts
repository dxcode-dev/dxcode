import { Schema } from "effect";

/**
 * An agent mode an installed plugin offers its person
 * (`GET /v1/plugin-agents/modes`): a new Thread started in it runs as the
 * plugin's agent.
 */
export const PluginAgentModeDataSchema = Schema.Struct({
  /** `plugin:<plugin name>/<key>`, as `pluginAgentMode` takes it. */
  mode: Schema.String,
  label: Schema.String.check(Schema.isMaxLength(24)),
  description: Schema.optional(Schema.String.check(Schema.isMaxLength(300))),
  color: Schema.optional(Schema.String),
  /** The plugin's display name. */
  plugin: Schema.String,
  /** The model the agent chose; absent when it runs on the picked mode. */
  model: Schema.optional(Schema.String),
  reasoningEffort: Schema.optional(Schema.String),
});

export type PluginAgentModeData = typeof PluginAgentModeDataSchema.Type;

export const PluginAgentModesResponseSchema = Schema.Struct({
  status: Schema.Literal("ok"),
  data: Schema.Struct({ modes: Schema.Array(PluginAgentModeDataSchema) }),
});

export type PluginAgentModesResponse =
  typeof PluginAgentModesResponseSchema.Type;
