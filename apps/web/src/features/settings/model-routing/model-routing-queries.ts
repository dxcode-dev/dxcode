import { queryOptions } from "@tanstack/react-query";
import {
  getModelCatalog,
  getModelRoutingChoices,
  getModelRoutingGraph,
  getModeProfile,
  listModelConnections,
  type ModelRoutingTarget,
} from "../../../shared/api/client.js";

export const modelRoutingKey = (target: ModelRoutingTarget) =>
  target.scope === "personal"
    ? (["model-routing", "personal"] as const)
    : (["model-routing", "workspace", target.workspaceSlug] as const);

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

export const modelRoutingGraphQueryOptions = (
  target: ModelRoutingTarget,
  identity: string,
) =>
  queryOptions({
    queryKey: [...modelRoutingKey(target), "graph", identity],
    queryFn: ({ signal }) => getModelRoutingGraph(target, signal),
  });

export const modelRoutingChoicesQueryOptions = (identity: string) =>
  queryOptions({
    queryKey: ["model-routing", "personal", "choices", identity],
    queryFn: ({ signal }) => getModelRoutingChoices(signal),
  });

export const modeProfileQueryOptions = (identity: string) =>
  queryOptions({
    queryKey: ["model-routing", "personal", "profile", identity],
    queryFn: ({ signal }) => getModeProfile(signal),
  });
