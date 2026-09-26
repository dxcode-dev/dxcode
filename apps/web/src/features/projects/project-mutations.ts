import type { ProjectData } from "@dx/api";
import type { ProjectId, RunnerProfileId, UserId } from "@dx/domain";
import {
  type InfiniteData,
  mutationOptions,
  type QueryClient,
} from "@tanstack/react-query";
import {
  type CreateProjectInput,
  createProject,
  type ProjectPage,
  rebindProjectSource,
  updateProject,
  uploadProjectIcon,
} from "../../shared/api/client.js";
import { projectKeys, seedProjectDetailFromList } from "./project-queries.js";

type ProjectListData = InfiniteData<ProjectPage, unknown>;

export const cacheProject = (
  queryClient: QueryClient,
  userId: UserId,
  project: ProjectData,
  prepend = false,
) =>
  Promise.all([
    queryClient.cancelQueries({
      queryKey: projectKeys.detail(userId, project.id),
      exact: true,
    }),
    queryClient.cancelQueries({
      queryKey: projectKeys.lists(userId),
      exact: true,
    }),
  ]).then(() => {
    queryClient.setQueryData(projectKeys.detail(userId, project.id), project);
    queryClient.setQueryData<ProjectListData>(
      projectKeys.lists(userId),
      (current) => {
        if (current === undefined || current.pages.length === 0) return current;
        const present = current.pages.some((page) =>
          page.items.some(({ id }) => id === project.id),
        );
        if (!present && !prepend) return current;
        return {
          ...current,
          pages: current.pages.map((page, index) => ({
            ...page,
            items: present
              ? page.items.map((item) =>
                  item.id === project.id ? project : item,
                )
              : index === 0
                ? [project, ...page.items]
                : page.items,
          })),
        };
      },
    );
  });

export const seedProjectDetail = (
  queryClient: QueryClient,
  userId: UserId,
  project: ProjectData,
) => {
  const detailKey = projectKeys.detail(userId, project.id);
  if (queryClient.getQueryData(detailKey) !== undefined) return;
  seedProjectDetailFromList(queryClient, userId, project.id);
  if (queryClient.getQueryData(detailKey) === undefined)
    queryClient.setQueryData(detailKey, project);
};

export const createProjectMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
) =>
  mutationOptions({
    mutationKey: [...projectKeys.all(userId), "create"] as const,
    mutationFn: (input: CreateProjectInput) => createProject(input),
    onSuccess: (project) => cacheProject(queryClient, userId, project, true),
  });

export interface UpdateProjectInput {
  readonly revision: number;
  readonly name?: string;
  readonly description?: string;
  readonly runnerProfileId?: RunnerProfileId;
}

export const updateProjectMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
  projectId: ProjectId,
) =>
  mutationOptions({
    mutationKey: [...projectKeys.detail(userId, projectId), "update"] as const,
    mutationFn: (input: UpdateProjectInput) => updateProject(projectId, input),
    onSuccess: (project) => cacheProject(queryClient, userId, project),
  });

export const rebindProjectSourceMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
  projectId: ProjectId,
) =>
  mutationOptions({
    mutationKey: [
      ...projectKeys.detail(userId, projectId),
      "source",
      "rebind",
    ] as const,
    mutationFn: (input: Parameters<typeof rebindProjectSource>[1]) =>
      rebindProjectSource(projectId, input),
    onSuccess: (project) => cacheProject(queryClient, userId, project),
  });

export const uploadProjectIconMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
  projectId: ProjectId,
) =>
  mutationOptions({
    mutationKey: [...projectKeys.detail(userId, projectId), "icon"] as const,
    mutationFn: ({
      revision,
      file,
    }: {
      readonly revision: number;
      readonly file: File;
    }) => uploadProjectIcon(projectId, revision, file),
    onSuccess: (project) => cacheProject(queryClient, userId, project),
    gcTime: 0,
  });
