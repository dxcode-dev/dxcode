import type { PluginAgentModeData } from "@dx/api";
import { queryOptions } from "@tanstack/react-query";

/**
 * The agent modes the person's installed plugins offer, for the New Thread
 * composer's Plugin Agents tab. They change only when a plugin is installed
 * or updated, so the list is kept for five minutes. The request and its
 * schema load apart from the Thread page's first load.
 */
export const pluginAgentModesQueryOptions = (userId: string) =>
  queryOptions({
    queryKey: ["plugin-agent-modes", userId] as const,
    queryFn: async ({ signal }): Promise<ReadonlyArray<PluginAgentModeData>> =>
      (
        await import("./plugin-agent-modes-request-queries.js")
      ).fetchPluginAgentModes(signal),
    staleTime: 5 * 60_000,
  });
