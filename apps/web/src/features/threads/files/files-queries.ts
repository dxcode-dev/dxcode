import type {
  ThreadFileData,
  ThreadFilesPath,
  ThreadFilesWorktreeId,
  ThreadFileVersion,
  WriteThreadFilesRequest,
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

/**
 * A published Changes capture means the workspace changed (a rename, a new
 * file); refetch the visible Files trees so they follow it.
 */
export const invalidateThreadFileTrees = (
  client: QueryClient,
  threadId: ThreadId,
) =>
  client.invalidateQueries(
    { queryKey: [...threadFilesKeys.all(threadId), "tree"] },
    { cancelRefetch: false },
  );

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
    // With nothing on screen yet, the root accepts the Orb's last listing
    // (`snapshotAt`), which shows at once while a paused Orb wakes; the live
    // read follows straight away and replaces it.
    queryFn: ({ pageParam, signal, client, queryKey }) =>
      api.list(
        threadId,
        path,
        pageParam,
        worktree,
        signal,
        path === undefined &&
          pageParam === undefined &&
          client.getQueryData(queryKey) === undefined,
      ),
    getNextPageParam: (page) => page.nextCursor,
    refetchInterval: (query) =>
      query.state.data?.pages[0]?.snapshotAt === undefined ? false : 100,
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

/** The Files tree after a write: every listing of the worktree and Changes. */
const refreshAfterWrite = (
  queryClient: QueryClient,
  threadId: ThreadId,
  worktree: ThreadFilesWorktreeId,
) =>
  Promise.all([
    queryClient.invalidateQueries({
      queryKey: [...threadFilesKeys.all(threadId), "tree", worktree],
    }),
    queryClient.invalidateQueries({ queryKey: changesKeys.all(threadId) }),
  ]);

/** Create, move, copy, or delete in one worktree. */
export const writeThreadFilesOptions = (
  api: ThreadFilesApi,
  threadId: ThreadId,
  worktree: ThreadFilesWorktreeId,
  queryClient: QueryClient,
) =>
  mutationOptions({
    retry: false,
    mutationFn: (request: WriteThreadFilesRequest) => {
      if (api.write === undefined) throw new Error("Files are read-only.");
      return api.write(threadId, request, worktree);
    },
    onSettled: () => refreshAfterWrite(queryClient, threadId, worktree),
  });

/** Upload files into one folder of a worktree, one after another. */
export const uploadThreadFilesOptions = (
  api: ThreadFilesApi,
  threadId: ThreadId,
  queryClient: QueryClient,
) =>
  mutationOptions({
    retry: false,
    mutationFn: async (input: {
      readonly worktree: ThreadFilesWorktreeId;
      readonly folder?: ThreadFilesPath;
      readonly files: readonly File[];
    }) => {
      const send = api.upload;
      if (send === undefined) throw new Error("Files are read-only.");
      // One after another: each upload holds the Thread's Changes lease.
      await input.files.reduce<Promise<unknown>>(
        (previous, file) =>
          previous.then(() =>
            send(
              threadId,
              (input.folder === undefined
                ? file.name
                : `${input.folder}/${file.name}`) as ThreadFilesPath,
              file,
              input.worktree,
            ),
          ),
        Promise.resolve(),
      );
      return { kind: "changed" as const };
    },
    onSettled: (_data, _error, input) =>
      refreshAfterWrite(queryClient, threadId, input.worktree),
  });
