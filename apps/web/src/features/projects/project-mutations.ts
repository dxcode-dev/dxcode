import {
  CreateProjectEndpoint,
  type CreateProjectRequestSchema,
  DeleteProjectEndpoint,
  type DeleteProjectRequest,
  RebindProjectSourceEndpoint,
  type RebindProjectSourceRequest,
  UpdateProjectEndpoint,
  UploadProjectIconEndpoint,
} from "@dx/api";
import type { ProjectId, RunnerProfileId, UserId } from "@dx/domain";
import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { type CreateProjectInput, dxClient } from "../../shared/api/client.js";
import { threadKeys } from "../threads/thread-queries.js";
import { cacheProject } from "./project-cache-mutations.js";
import { projectKeys } from "./project-queries.js";

export const createProjectMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
) =>
  mutationOptions({
    mutationKey: [...projectKeys.all(userId), "create"] as const,
    mutationFn: async (input: CreateProjectInput) =>
      (
        await dxClient.call(CreateProjectEndpoint, {
          // The same JSON: a provider repository ID is a plain string on the wire.
          body: input as typeof CreateProjectRequestSchema.Type,
        })
      ).data,
    onSuccess: (project) => cacheProject(queryClient, userId, project, true),
  });

export interface UpdateProjectInput {
  readonly revision: number;
  readonly name?: string;
  readonly description?: string;
  readonly runnerProfileId?: RunnerProfileId;
  readonly additionalRepositories?: ReadonlyArray<string>;
  /** Replaces the whole list. */
  readonly remoteAliases?: ReadonlyArray<string>;
}

export const updateProjectMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
  projectId: ProjectId,
) =>
  mutationOptions({
    mutationKey: [...projectKeys.detail(userId, projectId), "update"] as const,
    mutationFn: async (input: UpdateProjectInput) =>
      (
        await dxClient.call(UpdateProjectEndpoint, {
          params: { projectId },
          body: input,
        })
      ).data,
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
    mutationFn: async (input: RebindProjectSourceRequest) =>
      (
        await dxClient.call(RebindProjectSourceEndpoint, {
          params: { projectId },
          body: input,
        })
      ).data,
    onSuccess: (project) => cacheProject(queryClient, userId, project),
  });

export const uploadProjectIconMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
  projectId: ProjectId,
) =>
  mutationOptions({
    mutationKey: [...projectKeys.detail(userId, projectId), "icon"] as const,
    mutationFn: async ({
      revision,
      file,
    }: {
      readonly revision: number;
      readonly file: File;
    }) =>
      (
        await dxClient.call(
          UploadProjectIconEndpoint,
          { params: { projectId }, body: file },
          { headers: { "x-project-revision": String(revision) } },
        )
      ).data,
    onSuccess: (project) => cacheProject(queryClient, userId, project),
    gcTime: 0,
  });

/**
 * Deletes the project. Every project and Thread list refreshes: kept
 * Threads move to Archived and deleted ones disappear. The caller leaves
 * the project's pages, then drops its detail with `forgetDeletedProject`.
 */
export const deleteProjectMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
  projectId: ProjectId,
) =>
  mutationOptions({
    mutationKey: [...projectKeys.detail(userId, projectId), "delete"] as const,
    mutationFn: async (input: DeleteProjectRequest) =>
      (
        await dxClient.call(DeleteProjectEndpoint, {
          params: { projectId },
          body: input,
        })
      ).data,
    // Not awaited: the caller leaves the project's pages while lists refresh.
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: projectKeys.lists(userId),
      });
      void queryClient.invalidateQueries({ queryKey: threadKeys.all(userId) });
    },
  });

/** Drops a deleted project's detail, which would only refetch a 404. */
export const forgetDeletedProject = (
  queryClient: QueryClient,
  userId: UserId,
  projectId: ProjectId,
) =>
  queryClient.removeQueries({
    queryKey: projectKeys.detail(userId, projectId),
  });
