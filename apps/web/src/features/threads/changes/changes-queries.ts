import type {
  ThreadChangesCaptureId,
  ThreadChangesPath,
  ThreadChangesRange,
  ThreadChangesWorktreeId,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import {
  keepPreviousData,
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import type { ResolvedAppearance } from "../../../shared/theme/theme-store.js";
import { threadKeys } from "../thread-queries.js";
import type { ChangesTransport } from "./changes-api.js";

// FileDiff must mount after its bundled language and theme are ready. The
// diff library loads here, not at import: realtime code that every page loads
// imports these query keys.
export const changesHighlightQueryOptions = (
  path: ThreadChangesPath,
  appearance: ResolvedAppearance,
) => {
  const theme = appearance === "light" ? "pierre-light" : "pierre-dark";
  return queryOptions({
    queryKey: ["changes-highlighter", theme, path],
    queryFn: async () => {
      const { getFiletypeFromFileName, preloadHighlighter } = await import(
        "@pierre/diffs"
      );
      await preloadHighlighter({
        themes: [theme],
        langs: [getFiletypeFromFileName(path)],
      });
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
          // The route follows the newest capture. Keep its diff for the
          // list's next capture and refresh the list behind it.
          queryClient.setQueryData(
            changesKeys.diff(threadId, range, path, worktree, diff.captureId),
            diff,
          );
          void queryClient.invalidateQueries({
            queryKey: changesKeys.range(threadId, range),
          });
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
    // A new capture keeps the open diff on screen until its own diff loads.
    placeholderData: keepPreviousData,
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

/**
 * The Changes queries loaded for a Thread, for a bug report's Diff
 * Diagnostics: each key and its data, any that would pass `budget`
 * characters replaced by its size.
 */
export const loadedChanges = (
  client: QueryClient,
  threadId: ThreadId,
  budget: number,
) => {
  let remaining = budget;
  let truncated = false;
  const loaded = client
    .getQueriesData({ queryKey: changesKeys.all(threadId) })
    .slice(0, 200)
    .flatMap(([key, data]) => {
      if (data === undefined) return [];
      const size = JSON.stringify(data).length;
      if (size > remaining) {
        truncated = true;
        return [{ key, data: { omitted: `${size} characters` } }];
      }
      remaining -= size;
      return [{ key, data }];
    });
  return { loaded, truncated };
};
