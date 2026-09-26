import type { EnvironmentVariableData, PluginData } from "@dx/api";
import type { UserId } from "@dx/domain";
import { queryOptions } from "@tanstack/react-query";
import { listPlugins, type PluginsTarget } from "../../../shared/api/client.js";

export type { EnvironmentVariableData, PluginData, PluginsTarget };

export const pluginKeys = {
  all: (userId: UserId) => ["plugins", userId] as const,
  list: (userId: UserId, target: PluginsTarget) =>
    [...pluginKeys.all(userId), target] as const,
};

export const pluginsQueryOptions = (userId: UserId, target: PluginsTarget) =>
  queryOptions({
    queryKey: pluginKeys.list(userId, target),
    queryFn: ({ signal }) => listPlugins(target, signal),
    staleTime: 15_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: true,
  });
