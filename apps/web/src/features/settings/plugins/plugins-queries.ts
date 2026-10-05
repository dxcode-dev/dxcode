import type { FirstPartyPluginData, FirstPartyPluginListData } from "@dx/api";
import type { UserId } from "@dx/domain";
import { queryOptions } from "@tanstack/react-query";
import {
  listFirstPartyPlugins,
  type PluginsTarget,
} from "../../../shared/api/client.js";

export type { FirstPartyPluginData, FirstPartyPluginListData, PluginsTarget };

export const firstPartyPluginKeys = {
  all: (userId: UserId) => ["first-party-plugins", userId] as const,
  list: (userId: UserId, target: PluginsTarget) =>
    [...firstPartyPluginKeys.all(userId), target] as const,
};

export const firstPartyPluginsQueryOptions = (
  userId: UserId,
  target: PluginsTarget,
) =>
  queryOptions({
    queryKey: firstPartyPluginKeys.list(userId, target),
    queryFn: ({ signal }) => listFirstPartyPlugins(target, signal),
    staleTime: 15_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: true,
  });
