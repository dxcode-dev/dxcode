import type {
  ThreadFileData,
  ThreadFilesPath,
  ThreadFilesWorktreeId,
  ThreadFileVersion,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import {
  infiniteQueryOptions,
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { changesKeys } from "../changes/changes-queries.js";
import type { ThreadFilesApi } from "./files-api.js";

export const threadFilesKeys = {
  all: (threadId: ThreadId) => ["thread-files", threadId] as const,
  tree: (
    threadId: ThreadId,
    worktree: ThreadFilesWorktreeId,
    path?: ThreadFilesPath,
  ) =>
    [...threadFilesKeys.all(threadId), "tree", worktree, path ?? null] as const,
  file: (
    threadId: ThreadId,
    worktree: ThreadFilesWorktreeId,
    path: ThreadFilesPath,
  ) => [...threadFilesKeys.all(threadId), "file", worktree, path] as const,
};

export const threadFileTreeOptions = (
  api: ThreadFilesApi,
  threadId: ThreadId,
  worktree: ThreadFilesWorktreeId,
  path?: ThreadFilesPath,
  active = true,
) =>
  infiniteQueryOptions({
    queryKey: threadFilesKeys.tree(threadId, worktree, path),
    initialPageParam: undefined as Parameters<ThreadFilesApi["list"]>[2],
    queryFn: ({ pageParam, signal }) =>
      api.list(threadId, path, pageParam, worktree, signal),
    getNextPageParam: (page) => page.nextCursor,
    enabled: active,
    staleTime: 5_000,
    retry: 2,
    retryDelay: (attempt) => 250 * 2 ** attempt,
    refetchOnReconnect: "always",
    refetchOnWindowFocus: "always",
  });

export const threadFileOptions = (
  api: ThreadFilesApi,
  threadId: ThreadId,
  worktree: ThreadFilesWorktreeId,
  path: ThreadFilesPath,
  active = true,
) =>
  queryOptions({
    queryKey: threadFilesKeys.file(threadId, worktree, path),
    queryFn: ({ signal }) => api.read(threadId, path, worktree, signal),
    enabled: active,
    staleTime: 1_000,
    retry: 2,
    retryDelay: (attempt) => 250 * 2 ** attempt,
    refetchOnReconnect: "always",
    refetchOnWindowFocus: "always",
  });

export const saveThreadFileOptions = (
  api: ThreadFilesApi,
  threadId: ThreadId,
  worktree: ThreadFilesWorktreeId,
  queryClient: QueryClient,
) =>
  mutationOptions({
    retry: false,
    mutationFn: (input: {
      readonly path: ThreadFilesPath;
      readonly content: string;
      readonly expectedVersion: ThreadFileVersion;
    }) => api.save(threadId, input.path, { ...input, worktree }),
    onSuccess: async (saved, input) => {
      queryClient.setQueryData<ThreadFileData>(
        threadFilesKeys.file(threadId, worktree, input.path),
        (file) =>
          file?.editable
            ? {
                ...file,
                content: input.content,
                contentVersion: saved.contentVersion,
                sizeBytes: new TextEncoder().encode(input.content).byteLength,
              }
            : file,
      );
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: threadFilesKeys.file(threadId, worktree, input.path),
        }),
        queryClient.invalidateQueries({ queryKey: changesKeys.all(threadId) }),
      ]);
    },
  });
