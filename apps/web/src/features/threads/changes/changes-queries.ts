import type {
  ThreadChangesCaptureId,
  ThreadChangesPath,
  ThreadChangesRange,
  ThreadChangesWorktreeId,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { getFiletypeFromFileName, preloadHighlighter } from "@pierre/diffs";
import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { threadKeys } from "../thread-queries.js";
import type { ChangesTransport } from "./changes-api.js";
import type { ResolvedAppearance } from "../../../shared/theme/theme-store.js";

// FileDiff must mount after its bundled language and theme are ready.
export const changesHighlightQueryOptions = (
  path: ThreadChangesPath,
  appearance: ResolvedAppearance,
) => {
  const language = getFiletypeFromFileName(path);
  const theme = appearance === "light" ? "pierre-light" : "pierre-dark";
  return queryOptions({
    queryKey: ["changes-highlighter", theme, language],
    queryFn: async () => {
      await preloadHighlighter({ themes: [theme], langs: [language] });
      return true;
    },
    staleTime: Infinity,
    retry: false,
  });
};

export const changesKeys = {
  all: (threadId: ThreadId) => ["thread-changes", threadId] as const,
  ranges: (threadId: ThreadId) =>
    [...changesKeys.all(threadId), "range"] as const,
  range: (threadId: ThreadId, range: ThreadChangesRange) =>
    [...changesKeys.ranges(threadId), range] as const,
  diff: (
    threadId: ThreadId,
    range: ThreadChangesRange,
    path: ThreadChangesPath,
    worktree: ThreadChangesWorktreeId,
    captureId: ThreadChangesCaptureId,
  ) =>
    [
      ...changesKeys.all(threadId),
      "diff",
      range,
      worktree,
      path,
      captureId,
    ] as const,
};

export const invalidateChangesRanges = (
  client: QueryClient,
  threadId: ThreadId,
) =>
  client.invalidateQueries(
    { queryKey: changesKeys.ranges(threadId) },
    { cancelRefetch: false },
  );

export const invalidateAllChanges = (client: QueryClient) =>
  client.invalidateQueries({ queryKey: ["thread-changes"] });

export const changesQueryOptions = (
  transport: ChangesTransport,
  threadId: ThreadId,
  range: ThreadChangesRange,
) =>
  queryOptions({
    queryKey: changesKeys.range(threadId, range),
    queryFn: ({ signal }) => transport.getChanges(threadId, range, signal),
    staleTime: 4_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

export const changesDiffQueryOptions = (
  transport: ChangesTransport,
  threadId: ThreadId,
  path: ThreadChangesPath,
  worktree: ThreadChangesWorktreeId,
  range: ThreadChangesRange,
  captureId: ThreadChangesCaptureId,
  queryClient: QueryClient,
) =>
  queryOptions({
    queryKey: changesKeys.diff(threadId, range, path, worktree, captureId),
    queryFn: async ({ signal }) => {
      try {
        const diff = await transport.getDiff(
          threadId,
          path,
          range,
          captureId,
          signal,
          worktree,
        );
        if (diff.captureId !== captureId) {
          await queryClient.invalidateQueries({
            queryKey: changesKeys.range(threadId, range),
          });
          throw new Error("This diff belongs to a different Changes capture.");
        }
        return diff;
      } catch (cause) {
        if (cause instanceof Error && "status" in cause && cause.status === 409)
          await queryClient.invalidateQueries({
            queryKey: changesKeys.range(threadId, range),
          });
        throw cause;
      }
    },
    staleTime: Infinity,
    retry: false,
  });

export const pushChangesMutationOptions = (
  queryClient: QueryClient,
  transport: ChangesTransport,
  threadId: ThreadId,
) =>
  mutationOptions({
    mutationKey: [...changesKeys.all(threadId), "push"] as const,
    mutationFn: (input: Parameters<ChangesTransport["push"]>[1]) =>
      transport.push(threadId, input),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: changesKeys.all(threadId) }),
        queryClient.invalidateQueries({
          predicate: (query) => threadKeys.isList(query.queryKey),
        }),
      ]);
    },
  });
