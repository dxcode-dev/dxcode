import type { PluginBundleData, PluginBundleListData } from "@dx/api";
import type { UserId } from "@dx/domain";
import { queryOptions } from "@tanstack/react-query";
import {
  listPluginBundles,
  type PluginsTarget,
} from "../../../shared/api/client.js";

export type { PluginBundleData, PluginBundleListData };

export const pluginBundleKeys = {
  all: (userId: UserId) => ["plugin-bundles", userId] as const,
  list: (userId: UserId, target: PluginsTarget) =>
    [...pluginBundleKeys.all(userId), target] as const,
};

export const pluginBundlesQueryOptions = (
  userId: UserId,
  target: PluginsTarget,
) =>
  queryOptions({
    queryKey: pluginBundleKeys.list(userId, target),
    queryFn: ({ signal }) => listPluginBundles(target, signal),
    staleTime: 15_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: true,
  });
