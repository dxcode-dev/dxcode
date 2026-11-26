import { defineEndpoint } from "../http/endpoint.js";
import { PluginAgentModesResponseSchema } from "./plugin-agent-modes.js";

/** The plugin agent modes endpoint, apart from its schemas. */
export const ListPluginAgentModesEndpoint = defineEndpoint({
  id: "pluginAgents.modes",
  summary: "List the agent modes plugins offer",
  method: "GET",
  path: "/v1/plugin-agents/modes",
  success: PluginAgentModesResponseSchema,
});
