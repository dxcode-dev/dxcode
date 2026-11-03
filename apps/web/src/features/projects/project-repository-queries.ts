import {
  GetProjectRepositoryBrowseResponseSchema,
  normalizeProjectRepositoryPath,
  type ProjectRepositoryBrowseData,
  ProjectRepositoryPath,
} from "@dx/api";
import type { ProjectId, UserId } from "@dx/domain";
import { queryOptions } from "@tanstack/react-query";
import { Option, Schema } from "effect";
import { request } from "../../shared/api/client.js";
import { projectKeys } from "./project-queries.js";

/**
 * The Project page's `?path=`: a repository directory, or `undefined` for the
 * root, including when the value is not a safe directory path.
 */
export const projectRepositoryPathSearch = (value: unknown) => {
  if (typeof value !== "string") return undefined;
  const path = Schema.decodeUnknownOption(ProjectRepositoryPath)(
    normalizeProjectRepositoryPath(value),
  );
  return Option.isSome(path) && path.value !== "" ? path.value : undefined;
};

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
        await request(
          `/v1/projects/${encodeURIComponent(projectId)}/repository${
            path === "" ? "" : `?path=${encodeURIComponent(path)}`
          }`,
          GetProjectRepositoryBrowseResponseSchema,
          { signal },
        )
      ).data,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
  });
