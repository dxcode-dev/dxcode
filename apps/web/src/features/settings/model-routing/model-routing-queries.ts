import {
  GetPersonalModelRoutingChoicesEndpoint,
  GetPersonalModelRoutingGraphEndpoint,
  GetPersonalModeProfileEndpoint,
  GetWorkspaceModelRoutingChoicesEndpoint,
  GetWorkspaceModelRoutingGraphEndpoint,
  GetWorkspaceModeProfileEndpoint,
} from "@dx/api";
import type { WorkspaceSlug } from "@dx/domain";
import { queryOptions } from "@tanstack/react-query";
import {
  dxClient,
  type ModelRoutingTarget,
} from "../../../shared/api/client.js";

const getModelRoutingGraph = async (
  target: ModelRoutingTarget,
  signal?: AbortSignal,
) =>
  (target.scope === "personal"
    ? await dxClient.call(GetPersonalModelRoutingGraphEndpoint, {}, { signal })
    : await dxClient.call(
        GetWorkspaceModelRoutingGraphEndpoint,
        { params: { workspaceSlug: target.workspaceSlug } },
        { signal },
      )
  ).data;

const getModelRoutingChoices = async (signal?: AbortSignal) =>
  (await dxClient.call(GetPersonalModelRoutingChoicesEndpoint, {}, { signal }))
    .data;

const getModeProfile = async (signal?: AbortSignal) =>
  (await dxClient.call(GetPersonalModeProfileEndpoint, {}, { signal })).data;

const getWorkspaceModelRoutingChoices = async (
  workspaceSlug: WorkspaceSlug,
  signal?: AbortSignal,
) =>
  (
    await dxClient.call(
      GetWorkspaceModelRoutingChoicesEndpoint,
      { params: { workspaceSlug } },
      { signal },
    )
  ).data;

const getWorkspaceModeProfile = async (
  workspaceSlug: WorkspaceSlug,
  signal?: AbortSignal,
) =>
  (
    await dxClient.call(
      GetWorkspaceModeProfileEndpoint,
      { params: { workspaceSlug } },
      { signal },
    )
  ).data;

export const modelRoutingKey = (target: ModelRoutingTarget) =>
  target.scope === "personal"
    ? (["model-routing", "personal"] as const)
    : (["model-routing", "workspace", target.workspaceSlug] as const);

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
