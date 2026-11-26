import {
  GetProjectRepositoryBrowseEndpoint,
  type ProjectRepositoryBrowseData,
} from "@dx/api";
import type { ProjectId, UserId } from "@dx/domain";
import { queryOptions } from "@tanstack/react-query";
import { dxClient } from "../../shared/api/client.js";
import { projectKeys } from "./project-queries.js";

/** The primary repository's commits and one directory, read without an Orb. */
export const projectRepositoryQueryOptions = (
  userId: UserId,
  projectId: ProjectId,
  path = "",
) =>
  queryOptions({
    queryKey: [...projectKeys.detail(userId, projectId), "repository", path],
    queryFn: async ({ signal }): Promise<ProjectRepositoryBrowseData> =>
      (
        await dxClient.call(
          GetProjectRepositoryBrowseEndpoint,
          { params: { projectId }, query: path === "" ? {} : { path } },
          { signal },
        )
      ).data,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
  });
