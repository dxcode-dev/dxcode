import type { OrbProviderListData } from "@dx/api";
import type { ProjectId, UserId } from "@dx/domain";
import { queryOptions } from "@tanstack/react-query";
import {
  listOrbProviders,
  type PluginsTarget,
} from "../../../shared/api/client.js";

export type { OrbProviderListData, PluginsTarget };

export const orbProviderKeys = {
  all: (userId: UserId) => ["orb-providers", userId] as const,
  list: (userId: UserId, target: PluginsTarget, projectId?: ProjectId) =>
    [...orbProviderKeys.all(userId), target, projectId ?? null] as const,
};

/** True while a key's Orb template is still building in its account. */
export const orbTemplateBuilding = (data: OrbProviderListData | undefined) =>
  data !== undefined &&
  (data.providers.some(
    ({ key, workspaceKey }) =>
      key?.template?.status === "building" ||
      workspaceKey?.template?.status === "building",
  ) ||
    data.resolved.some(({ status }) => status === "building"));

/**
 * The Orb providers for a scope. A projectId resolves the set a new Thread
 * in that project could start on (the new-Thread picker). Polling drives a
 * template build forward while one is in progress.
 */
export const orbProvidersQueryOptions = (
  userId: UserId,
  target: PluginsTarget,
  projectId?: ProjectId,
) =>
  queryOptions({
    queryKey: orbProviderKeys.list(userId, target, projectId),
    queryFn: ({ signal }) => listOrbProviders(target, projectId, signal),
    staleTime: 15_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: true,
    refetchInterval: (query) =>
      orbTemplateBuilding(query.state.data) ? 10_000 : false,
  });
