import { type MoveProjectRequest, MoveProjectResponseSchema } from "@dx/api";
import type { ProjectId, UserId } from "@dx/domain";
import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { request } from "../../shared/api/client.js";
import { threadKeys } from "../threads/thread-queries.js";
import { cacheProject } from "./project-mutations.js";
import { projectKeys } from "./project-queries.js";

/**
 * Moves the personal project into the user's workspace (Change Owner,
 * #1198). The project's Threads now list under the workspace, so they
 * refresh too. Only the Change Owner card imports this module, which keeps
 * it in the lazy Project Settings route and out of the Thread page's first
 * load.
 */
export const moveProjectMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
  projectId: ProjectId,
) =>
  mutationOptions({
    mutationKey: [...projectKeys.detail(userId, projectId), "move"] as const,
    mutationFn: async (input: MoveProjectRequest) =>
      (
        await request(
          `/v1/projects/${encodeURIComponent(projectId)}/move`,
          MoveProjectResponseSchema,
          { method: "POST", body: JSON.stringify(input) },
        )
      ).data,
    onSuccess: async ({ project }) => {
      await cacheProject(queryClient, userId, project);
      void queryClient.invalidateQueries({
        queryKey: projectKeys.lists(userId),
      });
      void queryClient.invalidateQueries({ queryKey: threadKeys.all(userId) });
    },
  });
