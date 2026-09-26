import type {
  BulkEnvironmentVariablePreviewItem,
  EnvironmentVariableAuditEventData,
  EnvironmentVariableData,
} from "@dx/api";
import type { PageCursor, UserId } from "@dx/domain";
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import {
  type EnvironmentVariablesTarget,
  listEnvironmentVariableHistory,
  listEnvironmentVariables,
} from "../../../shared/api/client.js";

export type {
  BulkEnvironmentVariablePreviewItem,
  EnvironmentVariableAuditEventData,
  EnvironmentVariableData,
  EnvironmentVariablesTarget,
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
