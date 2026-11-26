import { ListPluginAgentModesEndpoint } from "@dx/api";
import { dxClient } from "../../shared/api/client.js";

/** `GET /v1/plugin-agents/modes`, loaded apart from the Thread page. */
export const fetchPluginAgentModes = async (signal: AbortSignal) =>
  (await dxClient.call(ListPluginAgentModesEndpoint, {}, { signal })).data
    .modes;
