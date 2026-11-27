import {
  GetProjectEndpoint,
  ListProjectsEndpoint,
  type ProjectData,
} from "@dx/api";
import type { PageCursor, ProjectId, UserId } from "@dx/domain";
import {
  type InfiniteData,
  infiniteQueryOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { ApiError, dxClient } from "../../shared/api/client.js";

/** One page of the person's Projects, 100 at a time. */
export const listProjects = async (
  cursor?: PageCursor,
  signal?: AbortSignal,
): Promise<ProjectPage> =>
  (
    await dxClient.call(
      ListProjectsEndpoint,
      { query: cursor === undefined ? { limit: 100 } : { limit: 100, cursor } },
      { signal },
    )
  ).data;

export const getProject = async (
  projectId: ProjectId,
  signal?: AbortSignal,
): Promise<ProjectData> =>
  (
    await dxClient.call(
      GetProjectEndpoint,
      { params: { projectId } },
      { signal },
    )
  ).data;

/** `GET /v1/projects/<id>` answered that the project does not exist. */
export const isMissingProjectError = (error: unknown) =>
  error instanceof ApiError && error.status === 404;

const staleTime = 30_000;
const gcTime = 5 * 60_000;

export const projectKeys = {
  all: (userId: UserId) => ["projects", userId] as const,
  lists: (userId: UserId) => [...projectKeys.all(userId), "list"] as const,
  detail: (userId: UserId, projectId: ProjectId) =>
    [...projectKeys.all(userId), "detail", projectId] as const,
};

export const projectsQueryOptions = (userId: UserId) =>
  infiniteQueryOptions({
    queryKey: projectKeys.lists(userId),
    queryFn: ({ pageParam, signal }) => listProjects(pageParam, signal),
    initialPageParam: undefined as PageCursor | undefined,
    getNextPageParam: (page) => page.nextCursor,
    staleTime,
    gcTime,
    refetchOnWindowFocus: true,
  });

/**
 * The Project as the cached Project list holds it, shown while the Project's
 * own read is in flight, so a page that names its Project does not wait on
 * a second round trip (#1156).
 */
export const listedProject = (
  client: QueryClient,
  userId: UserId,
  projectId: ProjectId,
) =>
  client
    .getQueryData<InfiniteData<ProjectPage>>(projectKeys.lists(userId))
    ?.pages.flatMap((page) => page.items)
    .find((project) => project.id === projectId);

export const projectQueryOptions = (userId: UserId, projectId: ProjectId) =>
  queryOptions({
    queryKey: projectKeys.detail(userId, projectId),
    queryFn: ({ signal }) => getProject(projectId, signal),
    staleTime,
    gcTime,
    refetchOnWindowFocus: true,
  });

export const seedProjectDetailFromList = (
  queryClient: QueryClient,
  userId: UserId,
  projectId: ProjectId,
) => {
  const detailKey = projectKeys.detail(userId, projectId);
  if (queryClient.getQueryData(detailKey) !== undefined) return;
  const listKey = projectKeys.lists(userId);
  const project = queryClient
    .getQueryData<InfiniteData<ProjectPage>>(listKey)
    ?.pages.flatMap((page) => page.items)
    .find(({ id }) => id === projectId);
  if (project !== undefined)
    queryClient.setQueryData(detailKey, project, {
      updatedAt: queryClient.getQueryState(listKey)?.dataUpdatedAt,
    });
};

export interface ProjectPage {
  readonly items: ReadonlyArray<ProjectData>;
  readonly nextCursor?: PageCursor;
}
