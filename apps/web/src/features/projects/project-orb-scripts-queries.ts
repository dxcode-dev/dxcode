import {
  GetProjectOrbScriptsResponseSchema,
  type ProjectOrbScriptsData,
  UpdateProjectOrbScriptResponseSchema,
} from "@dx/api";
import type { ProjectId, ProjectOrbScriptKind, UserId } from "@dx/domain";
import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { request } from "../../shared/api/client.js";
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
        await request(
          `/v1/projects/${encodeURIComponent(projectId)}/orb-scripts`,
          GetProjectOrbScriptsResponseSchema,
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
        await request(
          `/v1/projects/${encodeURIComponent(projectId)}/orb-scripts/${kind}`,
          UpdateProjectOrbScriptResponseSchema,
          { method: "PUT", body: JSON.stringify({ body }) },
        )
      ).data,
    onSuccess: (data) =>
      queryClient.setQueryData(projectOrbScriptsKey(userId, projectId), data),
  });
