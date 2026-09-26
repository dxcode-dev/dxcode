import type { PageCursor, ProjectId, ThreadId, UserId } from "@dx/domain";
import {
  infiniteQueryOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import {
  getThread,
  getThreadReadiness,
  listThreads,
} from "../../shared/api/client.js";

const staleTime = 30_000;
const gcTime = 5 * 60_000;
export const THREAD_FRESHNESS_SLO_MS = 60_000;
export const READINESS_FALLBACK_INTERVAL_MS = 5_000;

export const threadKeys = {
  isList: (queryKey: readonly unknown[]) =>
    queryKey[0] === "threads" && queryKey[2] === "list",
  all: (userId: UserId) => ["threads", userId] as const,
  lists: (userId: UserId) => [...threadKeys.all(userId), "list"] as const,
  list: (
    userId: UserId,
    projectId?: ProjectId,
    lifecycleState?: "active" | "archived",
  ) =>
    [
      ...threadKeys.lists(userId),
      { projectId: projectId ?? null, lifecycleState: lifecycleState ?? null },
    ] as const,
  detail: (userId: UserId, threadId: ThreadId) =>
    [...threadKeys.all(userId), "detail", threadId] as const,
};

export const invalidateAllThreadQueries = (
  client: QueryClient,
  userId: UserId,
) => client.invalidateQueries({ queryKey: threadKeys.all(userId) });

export const invalidateThreadLists = (client: QueryClient, userId: UserId) =>
  client.invalidateQueries({ queryKey: threadKeys.lists(userId) });

export const invalidateThreadQueries = async (
  client: QueryClient,
  userId: UserId,
  threadId: ThreadId,
) => {
  await Promise.all([
    invalidateThreadLists(client, userId),
    client.invalidateQueries({ queryKey: threadKeys.detail(userId, threadId) }),
  ]);
};

export const invalidateReadinessQuery = (
  client: QueryClient,
  userId: UserId,
  threadId: ThreadId,
) =>
  client.invalidateQueries({
    queryKey: threadKeys.detail(userId, threadId),
  });

export const threadsQueryOptions = (
  userId: UserId,
  projectId?: ProjectId,
  lifecycleState?: "active" | "archived",
) =>
  infiniteQueryOptions({
    queryKey: threadKeys.list(userId, projectId, lifecycleState),
    queryFn: ({ pageParam, signal }) =>
      listThreads(projectId, pageParam, signal, lifecycleState),
    initialPageParam: undefined as PageCursor | undefined,
    getNextPageParam: (page) => page.nextCursor,
    staleTime,
    gcTime,
    refetchInterval: THREAD_FRESHNESS_SLO_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
  });

export const threadQueryOptions = (userId: UserId, threadId: ThreadId) =>
  queryOptions({
    queryKey: threadKeys.detail(userId, threadId),
    queryFn: async ({ client, queryKey, signal }) => {
      const current =
        client.getQueryData<Awaited<ReturnType<typeof getThread>>>(queryKey);
      if (current?.executionWorkspace.ready === false) {
        const executionWorkspace = await getThreadReadiness(threadId, signal);
        // Readiness polling deliberately avoids the larger detail payload, but the
        // transition is also the point where workspace-derived detail becomes
        // authoritative. Do not leave the pre-ready snapshot in cache.
        if (executionWorkspace.ready) return getThread(threadId, signal);
        return { ...current, executionWorkspace };
      }
      return getThread(threadId, signal);
    },
    staleTime,
    gcTime,
    refetchInterval: (query) =>
      query.state.data?.executionWorkspace.ready === false
        ? READINESS_FALLBACK_INTERVAL_MS
        : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
