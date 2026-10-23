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

/** True while dx prepares a connection's account (or one is listed so). */
export const orbConnectionPreparing = (data: OrbProviderListData | undefined) =>
  data !== undefined &&
  (data.providers.some(
    ({ connection, workspaceConnection }) =>
      connection?.status === "preparing" ||
      workspaceConnection?.status === "preparing",
  ) ||
    data.resolved.some(({ status }) => status === "preparing"));

/**
 * The Orb providers for a scope. A projectId resolves the set a new Thread
 * in that project could start on (the new-Thread picker). It polls while a
 * connection is preparing, so its progress and readiness show up.
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
      orbConnectionPreparing(query.state.data) ? 5_000 : false,
  });
