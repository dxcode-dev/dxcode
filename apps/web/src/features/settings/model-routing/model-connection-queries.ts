import type { ConnectionData } from "@dx/api";
import {
  CheckPersonalModelConnectionAccessEndpoint,
  CheckWorkspaceModelConnectionAccessEndpoint,
  GetPersonalModelCatalogEndpoint,
  GetWorkspaceModelCatalogEndpoint,
  ListPersonalModelConnectionsEndpoint,
  ListWorkspaceModelConnectionsEndpoint,
} from "@dx/api";
import type { ModelConnectionId } from "@dx/domain";
import { type QueryClient, queryOptions } from "@tanstack/react-query";
import {
  dxClient,
  type ModelRoutingTarget,
} from "../../../shared/api/client.js";
import { modelRoutingKey } from "./model-routing-queries.js";

/*
 * Settings → Models: connections and the catalog. Apart from
 * `model-routing-queries.ts`, whose choices and graph the Thread page reads
 * on first load, so their endpoints stay off it.
 */

/** Callers pass the id they read; Core refuses one it cannot find. */
export const connectionParams = (connectionId: string) => ({
  connectionId: connectionId as ModelConnectionId,
});

const getModelCatalog = async (
  target: ModelRoutingTarget,
  signal?: AbortSignal,
) =>
  (target.scope === "personal"
    ? await dxClient.call(GetPersonalModelCatalogEndpoint, {}, { signal })
    : await dxClient.call(
        GetWorkspaceModelCatalogEndpoint,
        { params: { workspaceSlug: target.workspaceSlug } },
        { signal },
      )
  ).data;

const listModelConnections = async (
  target: ModelRoutingTarget,
  signal?: AbortSignal,
): Promise<ReadonlyArray<ConnectionData>> =>
  (target.scope === "personal"
    ? await dxClient.call(ListPersonalModelConnectionsEndpoint, {}, { signal })
    : await dxClient.call(
        ListWorkspaceModelConnectionsEndpoint,
        { params: { workspaceSlug: target.workspaceSlug } },
        { signal },
      )
  ).data.connections;

export const checkModelConnectionAccess = async (
  target: ModelRoutingTarget,
  connectionId: string,
) =>
  (target.scope === "personal"
    ? await dxClient.call(CheckPersonalModelConnectionAccessEndpoint, {
        params: connectionParams(connectionId),
      })
    : await dxClient.call(CheckWorkspaceModelConnectionAccessEndpoint, {
        params: {
          workspaceSlug: target.workspaceSlug,
          ...connectionParams(connectionId),
        },
      })
  ).data;

export const modelConnectionsQueryOptions = (
  target: ModelRoutingTarget,
  identity: string,
) =>
  queryOptions({
    queryKey: [...modelRoutingKey(target), "connections", identity],
    queryFn: ({ signal }) => listModelConnections(target, signal),
  });

export const modelCatalogQueryOptions = (
  target: ModelRoutingTarget,
  identity: string,
) =>
  queryOptions({
    queryKey: [...modelRoutingKey(target), "catalog", identity],
    queryFn: ({ signal }) => getModelCatalog(target, signal),
  });

/**
 * A Claude Pro/Max plan's limits, read from Anthropic by the connection's
 * access check each time its panel opens or the owner refreshes it. The
 * connections list then shows the reading. The key sits outside
 * `modelRoutingKey`, so saving a setting does not read the plan again.
 */
export const claudePlanRefreshQueryOptions = (
  queryClient: QueryClient,
  target: ModelRoutingTarget,
  connectionId: string,
) =>
  queryOptions({
    queryKey: ["claude-plan-refresh", target, connectionId],
    queryFn: async () => {
      const connection = await checkModelConnectionAccess(target, connectionId);
      queryClient.setQueriesData<ReadonlyArray<ConnectionData>>(
        { queryKey: [...modelRoutingKey(target), "connections"] },
        (connections) =>
          connections?.map((current) =>
            current.id === connection.id ? connection : current,
          ),
      );
      return connection;
    },
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
