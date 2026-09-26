import type {
  ExternalApiApplicationId,
  PageCursor,
  UserId,
  WorkspaceSlug,
} from "@dx/domain";
import { infiniteQueryOptions } from "@tanstack/react-query";
import {
  listExternalApiApplicationAudit,
  listExternalApiApplications,
} from "../../../shared/api/client.js";
import { workspaceKeys } from "../workspace/workspace-queries.js";

export const applicationKeys = {
  all: (userId: UserId, workspaceSlug: WorkspaceSlug) =>
    [...workspaceKeys.detail(userId, workspaceSlug), "applications"] as const,
  lists: (userId: UserId, workspaceSlug: WorkspaceSlug) =>
    [...applicationKeys.all(userId, workspaceSlug), "list"] as const,
  audits: (userId: UserId, workspaceSlug: WorkspaceSlug) =>
    [...applicationKeys.all(userId, workspaceSlug), "audit"] as const,
  audit: (
    userId: UserId,
    workspaceSlug: WorkspaceSlug,
    applicationId: ExternalApiApplicationId,
  ) =>
    [...applicationKeys.audits(userId, workspaceSlug), applicationId] as const,
};

export const applicationsQueryOptions = (
  userId: UserId,
  workspaceSlug: WorkspaceSlug,
) =>
  infiniteQueryOptions({
    queryKey: applicationKeys.lists(userId, workspaceSlug),
    queryFn: ({ pageParam, signal }) =>
      listExternalApiApplications(workspaceSlug, pageParam, signal),
    initialPageParam: undefined as PageCursor | undefined,
    getNextPageParam: (page) => page.nextCursor,
    staleTime: 15_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: true,
  });

export const applicationAuditQueryOptions = (
  userId: UserId,
  workspaceSlug: WorkspaceSlug,
  applicationId: ExternalApiApplicationId,
) =>
  infiniteQueryOptions({
    queryKey: applicationKeys.audit(userId, workspaceSlug, applicationId),
    queryFn: ({ pageParam, signal }) =>
      listExternalApiApplicationAudit(
        workspaceSlug,
        applicationId,
        pageParam,
        signal,
      ),
    initialPageParam: undefined as PageCursor | undefined,
    getNextPageParam: (page) => page.nextCursor,
    staleTime: 10_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: true,
  });
