import {
  type ExternalApiApplicationAuditEventData,
  type ExternalApiApplicationData,
  ListExternalApiApplicationAuditEndpoint,
  ListExternalApiApplicationsEndpoint,
} from "@dx/api";
import type {
  ExternalApiApplicationId,
  PageCursor,
  UserId,
  WorkspacePermission,
  WorkspaceSlug,
} from "@dx/domain";
import { infiniteQueryOptions } from "@tanstack/react-query";
import { dxClient } from "../../../shared/api/client.js";
import { workspaceKeys } from "../workspace/workspace-queries.js";

interface ExternalApiApplicationPage {
  readonly items: ReadonlyArray<ExternalApiApplicationData>;
  readonly nextCursor?: PageCursor;
  readonly permissions: ReadonlyArray<WorkspacePermission>;
}

interface ExternalApiApplicationAuditPage {
  readonly items: ReadonlyArray<ExternalApiApplicationAuditEventData>;
  readonly nextCursor?: PageCursor;
}

const listExternalApiApplications = async (
  workspaceSlug: WorkspaceSlug,
  cursor?: PageCursor,
  signal?: AbortSignal,
): Promise<ExternalApiApplicationPage> =>
  (
    await dxClient.call(
      ListExternalApiApplicationsEndpoint,
      {
        params: { workspaceSlug },
        query: { limit: 20, ...(cursor === undefined ? {} : { cursor }) },
      },
      { signal },
    )
  ).data;

const listExternalApiApplicationAudit = async (
  workspaceSlug: WorkspaceSlug,
  applicationId: ExternalApiApplicationId,
  cursor?: PageCursor,
  signal?: AbortSignal,
): Promise<ExternalApiApplicationAuditPage> =>
  (
    await dxClient.call(
      ListExternalApiApplicationAuditEndpoint,
      {
        params: { workspaceSlug, applicationId },
        query: { limit: 25, ...(cursor === undefined ? {} : { cursor }) },
      },
      { signal },
    )
  ).data;

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
