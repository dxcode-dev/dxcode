import { queryOptions } from "@tanstack/react-query";
import {
  getModelCatalog,
  getModelRoutingChoices,
  getModelRoutingGraph,
  getModeProfile,
  getWorkspaceModelRoutingChoices,
  getWorkspaceModeProfile,
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

export const modelRoutingChoicesQueryOptions = (
  identity: string,
  target: ModelRoutingTarget = { scope: "personal" },
) =>
  queryOptions({
    queryKey: [...modelRoutingKey(target), "choices", identity],
    queryFn: ({ signal }) =>
      target.scope === "personal"
        ? getModelRoutingChoices(signal)
        : getWorkspaceModelRoutingChoices(target.workspaceSlug, signal),
  });

export const modeProfileQueryOptions = (
  identity: string,
  target: ModelRoutingTarget = { scope: "personal" },
) =>
  queryOptions({
    queryKey: [...modelRoutingKey(target), "profile", identity],
    queryFn: ({ signal }) =>
      target.scope === "personal"
        ? getModeProfile(signal)
        : getWorkspaceModeProfile(target.workspaceSlug, signal),
  });
