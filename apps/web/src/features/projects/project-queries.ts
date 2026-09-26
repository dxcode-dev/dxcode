import type { PageCursor, ProjectId, UserId } from "@dx/domain";
import {
  type InfiniteData,
  infiniteQueryOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import {
  getProject,
  listProjects,
  type ProjectPage,
} from "../../shared/api/client.js";

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
