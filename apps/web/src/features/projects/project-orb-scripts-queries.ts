import {
  GetProjectOrbScriptsEndpoint,
  type ProjectOrbScriptsData,
  UpdateProjectOrbScriptEndpoint,
} from "@dx/api";
import type { ProjectId, ProjectOrbScriptKind, UserId } from "@dx/domain";
import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { dxClient } from "../../shared/api/client.js";
import { projectKeys } from "./project-queries.js";

export const projectOrbScriptsKey = (userId: UserId, projectId: ProjectId) =>
  [...projectKeys.detail(userId, projectId), "orb-scripts"] as const;

export const projectOrbScriptsQueryOptions = (
  userId: UserId,
  projectId: ProjectId,
) =>
  queryOptions({
    queryKey: projectOrbScriptsKey(userId, projectId),
    queryFn: async ({ signal }): Promise<ProjectOrbScriptsData> =>
      (
        await dxClient.call(
          GetProjectOrbScriptsEndpoint,
          { params: { projectId } },
          { signal },
        )
      ).data,
    staleTime: 30_000,
  });

/** Saves one script; an empty body removes it. */
export const updateProjectOrbScriptMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
  projectId: ProjectId,
  kind: ProjectOrbScriptKind,
) =>
  mutationOptions({
    mutationKey: [...projectOrbScriptsKey(userId, projectId), kind],
    mutationFn: async (body: string) =>
      (
        await dxClient.call(UpdateProjectOrbScriptEndpoint, {
          params: { projectId, kind },
          body: { body },
        })
      ).data,
    onSuccess: (data) =>
      queryClient.setQueryData(projectOrbScriptsKey(userId, projectId), data),
  });
