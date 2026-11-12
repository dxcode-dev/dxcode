import { PluginAgentModesResponseSchema } from "@dx/api";
import { request } from "../../shared/api/client.js";

/** `GET /v1/plugin-agents/modes`, loaded apart from the Thread page. */
export const fetchPluginAgentModes = async (signal: AbortSignal) =>
  (
    await request("/v1/plugin-agents/modes", PluginAgentModesResponseSchema, {
      signal,
    })
  ).data.modes;
