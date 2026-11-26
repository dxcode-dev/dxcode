import {
  type BulkEnvironmentVariablePreviewItem,
  type EnvironmentVariableAuditEventData,
  type EnvironmentVariableData,
  ListPersonalEnvironmentVariableHistoryEndpoint,
  ListPersonalEnvironmentVariablesEndpoint,
  ListWorkspaceEnvironmentVariableHistoryEndpoint,
  ListWorkspaceEnvironmentVariablesEndpoint,
} from "@dx/api";
import type { PageCursor, ProjectId, UserId, WorkspaceSlug } from "@dx/domain";
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { dxClient } from "../../../shared/api/client.js";

export type EnvironmentVariablesTarget =
  | { readonly scope: "personal" }
  | { readonly scope: "project"; readonly projectId: ProjectId }
  | { readonly scope: "workspace"; readonly workspaceSlug: WorkspaceSlug };

/** The `scope` (and Project) a personal route reads from its query or body. */
export const environmentVariablesScope = (
  target: EnvironmentVariablesTarget,
) =>
  target.scope === "project"
    ? { scope: target.scope, projectId: target.projectId }
    : { scope: target.scope };

export const listEnvironmentVariables = async (
  target: EnvironmentVariablesTarget,
  signal?: AbortSignal,
) =>
  (target.scope === "workspace"
    ? await dxClient.call(
        ListWorkspaceEnvironmentVariablesEndpoint,
        { params: { workspaceSlug: target.workspaceSlug } },
        { signal },
      )
    : await dxClient.call(
        ListPersonalEnvironmentVariablesEndpoint,
        { query: environmentVariablesScope(target) },
        { signal },
      )
  ).data;

export const listEnvironmentVariableHistory = async (
  target: EnvironmentVariablesTarget,
  cursor?: PageCursor,
  signal?: AbortSignal,
): Promise<{
  readonly items: ReadonlyArray<EnvironmentVariableAuditEventData>;
  readonly nextCursor?: PageCursor;
}> => {
  const query = {
    scope: target.scope,
    limit: 20,
    ...(target.scope === "project" ? { projectId: target.projectId } : {}),
    ...(cursor === undefined ? {} : { cursor }),
  };
  return (
    target.scope === "workspace"
      ? await dxClient.call(
          ListWorkspaceEnvironmentVariableHistoryEndpoint,
          { params: { workspaceSlug: target.workspaceSlug }, query },
          { signal },
        )
      : await dxClient.call(
          ListPersonalEnvironmentVariableHistoryEndpoint,
          { query },
          { signal },
        )
  ).data;
};

export type {
  BulkEnvironmentVariablePreviewItem,
  EnvironmentVariableAuditEventData,
  EnvironmentVariableData,
};

export const environmentVariableKeys = {
  all: (userId: UserId) => ["environment-variables", userId] as const,
  scope: (userId: UserId, target: EnvironmentVariablesTarget) =>
    [...environmentVariableKeys.all(userId), target] as const,
  list: (userId: UserId, target: EnvironmentVariablesTarget) =>
    [...environmentVariableKeys.scope(userId, target), "list"] as const,
  history: (userId: UserId, target: EnvironmentVariablesTarget) =>
    [...environmentVariableKeys.scope(userId, target), "history"] as const,
};

export const environmentVariablesQueryOptions = (
  userId: UserId,
  target: EnvironmentVariablesTarget,
) =>
  queryOptions({
    queryKey: environmentVariableKeys.list(userId, target),
    queryFn: ({ signal }) => listEnvironmentVariables(target, signal),
    staleTime: 15_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: true,
  });

export const environmentVariableHistoryQueryOptions = (
  userId: UserId,
  target: EnvironmentVariablesTarget,
) =>
  infiniteQueryOptions({
    queryKey: environmentVariableKeys.history(userId, target),
    queryFn: ({ pageParam, signal }) =>
      listEnvironmentVariableHistory(target, pageParam, signal),
    initialPageParam: undefined as PageCursor | undefined,
    getNextPageParam: (page) => page.nextCursor,
    staleTime: 15_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: true,
  });
