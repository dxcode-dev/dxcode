import type { ProjectDefaultsData } from "@dx/api";
import {
  GetPersonalProjectDefaultsEndpoint,
  GetWorkspaceProjectDefaultsEndpoint,
} from "@dx/api";
import type { UserId, WorkspaceSlug } from "@dx/domain";
import { queryOptions } from "@tanstack/react-query";
import { dxClient } from "../../../shared/api/client.js";

const getProjectDefaults = async (
  target: ProjectDefaultsTarget,
  signal?: AbortSignal,
): Promise<ProjectDefaultsData> =>
  (target.scope === "personal"
    ? await dxClient.call(GetPersonalProjectDefaultsEndpoint, {}, { signal })
    : await dxClient.call(
        GetWorkspaceProjectDefaultsEndpoint,
        { params: { workspaceSlug: target.workspaceSlug } },
        { signal },
      )
  ).data;

export type { ProjectDefaultsData };

export const projectDefaultsKeys = {
  all: (userId: UserId) => ["project-defaults", userId] as const,
  detail: (userId: UserId, target: ProjectDefaultsTarget) =>
    [...projectDefaultsKeys.all(userId), target] as const,
};

export const projectDefaultsQueryOptions = (
  userId: UserId,
  target: ProjectDefaultsTarget,
) =>
  queryOptions({
    queryKey: projectDefaultsKeys.detail(userId, target),
    queryFn: ({ signal }) => getProjectDefaults(target, signal),
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: true,
  });

export type ProjectDefaultsTarget =
  | { readonly scope: "personal" }
  | { readonly scope: "workspace"; readonly workspaceSlug: WorkspaceSlug };
