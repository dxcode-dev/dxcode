import type { OrbProviderListData } from "@dx/api";
import type { ProjectId, UserId } from "@dx/domain";
import { queryOptions } from "@tanstack/react-query";
import {
  listOrbProviders,
  type PluginsTarget,
} from "../../../shared/api/client.js";
import { retryQuery } from "../../../shared/query/query-retry.js";

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
 * How long one provider-list request may take. The new-Thread Orb picker
 * waits for the list, so a request that never answers becomes an error with
 * Retry instead of an endless spinner.
 */
const ORB_PROVIDERS_TIMEOUT_MS = 10_000;

const timedOut = (error: unknown) =>
  error instanceof DOMException && error.name === "TimeoutError";

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
    queryFn: ({ signal }) =>
      listOrbProviders(
        target,
        projectId,
        AbortSignal.any([
          signal,
          AbortSignal.timeout(ORB_PROVIDERS_TIMEOUT_MS),
        ]),
      ),
    // A request that already waited out its deadline fails at once.
    retry: (failureCount, error) =>
      !timedOut(error) && retryQuery(failureCount, error),
    staleTime: 15_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: true,
    refetchInterval: (query) =>
      orbConnectionPreparing(query.state.data) ? 5_000 : false,
  });

/**
 * The providers a new Thread could start on: in its Project, or with No
 * Project (""), always for the person's own scope.
 */
export const newThreadOrbProvidersQueryOptions = (
  userId: UserId,
  projectId: ProjectId | "",
) =>
  orbProvidersQueryOptions(
    userId,
    { scope: "personal" },
    projectId === "" ? undefined : projectId,
  );
