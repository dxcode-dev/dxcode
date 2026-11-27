import type { FirstPartyPluginData, FirstPartyPluginListData } from "@dx/api";
import {
  ListPersonalFirstPartyPluginsEndpoint,
  ListWorkspaceFirstPartyPluginsEndpoint,
} from "@dx/api";
import type { UserId, WorkspaceSlug } from "@dx/domain";
import { queryOptions } from "@tanstack/react-query";
import { dxClient } from "../../../shared/api/client.js";

export const listFirstPartyPlugins = async (
  target: PluginsTarget,
  signal?: AbortSignal,
) =>
  (target.scope === "personal"
    ? await dxClient.call(ListPersonalFirstPartyPluginsEndpoint, {}, { signal })
    : await dxClient.call(
        ListWorkspaceFirstPartyPluginsEndpoint,
        { params: { workspaceSlug: target.workspaceSlug } },
        { signal },
      )
  ).data;

export type { FirstPartyPluginData, FirstPartyPluginListData };

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

export type PluginsTarget =
  | { readonly scope: "personal" }
  | { readonly scope: "workspace"; readonly workspaceSlug: WorkspaceSlug };
