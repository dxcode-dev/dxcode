import {
  GetThreadOrbMetricsResponseSchema,
  GetThreadOrbSessionsResponseSchema,
  GetThreadUsageRequestsResponseSchema,
  GetThreadUsageResponseSchema,
  type ThreadOrbMetricsData,
  type ThreadOrbSessionsData,
  type ThreadUsageData,
  type ThreadUsageRequestsData,
} from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { request } from "../../../shared/api/client.js";

/** A Thread's Cost & Usage: the menu's cost row and its dialog. */

const threadPath = (threadId: ThreadId) =>
  `/v1/threads/${encodeURIComponent(threadId)}/usage`;

const withCursor = (path: string, query: URLSearchParams, cursor?: string) => {
  if (cursor !== undefined) query.set("cursor", cursor);
  const search = query.toString();
  return search === "" ? path : `${path}?${search}`;
};

export const getThreadUsage = async (
  threadId: ThreadId,
  signal?: AbortSignal,
): Promise<ThreadUsageData> =>
  (
    await request(threadPath(threadId), GetThreadUsageResponseSchema, {
      signal,
    })
  ).data;

export const getThreadUsageRequests = async (
  threadId: ThreadId,
  input: {
    readonly providerId: string;
    readonly modelId: string;
    readonly cursor?: string;
  },
  signal?: AbortSignal,
): Promise<ThreadUsageRequestsData> =>
  (
    await request(
      withCursor(
        `${threadPath(threadId)}/requests`,
        new URLSearchParams({
          providerId: input.providerId,
          modelId: input.modelId,
        }),
        input.cursor,
      ),
      GetThreadUsageRequestsResponseSchema,
      { signal },
    )
  ).data;

export const getThreadOrbSessions = async (
  threadId: ThreadId,
  cursor: string | undefined,
  signal?: AbortSignal,
): Promise<ThreadOrbSessionsData> =>
  (
    await request(
      withCursor(
        `${threadPath(threadId)}/orb-sessions`,
        new URLSearchParams(),
        cursor,
      ),
      GetThreadOrbSessionsResponseSchema,
      { signal },
    )
  ).data;

export const getThreadOrbMetrics = async (
  threadId: ThreadId,
  signal?: AbortSignal,
): Promise<ThreadOrbMetricsData> =>
  (
    await request(
      `${threadPath(threadId)}/orb-metrics`,
      GetThreadOrbMetricsResponseSchema,
      { signal },
    )
  ).data;

export const threadUsageKeys = {
  thread: (userId: UserId, threadId: ThreadId) =>
    ["usage", userId, "thread", threadId] as const,
  summary: (userId: UserId, threadId: ThreadId) =>
    [...threadUsageKeys.thread(userId, threadId), "summary"] as const,
  requests: (
    userId: UserId,
    threadId: ThreadId,
    providerId: string,
    modelId: string,
  ) =>
    [
      ...threadUsageKeys.thread(userId, threadId),
      "requests",
      providerId,
      modelId,
    ] as const,
  orbSessions: (userId: UserId, threadId: ThreadId) =>
    [...threadUsageKeys.thread(userId, threadId), "orb-sessions"] as const,
  orbMetrics: (userId: UserId, threadId: ThreadId) =>
    [...threadUsageKeys.thread(userId, threadId), "orb-metrics"] as const,
};

/**
 * The Thread's cost, tokens, routes, models, Orb time, and context. Read
 * when the menu opens; the dialog it opens reuses that read rather than
 * fetching again.
 */
export const threadUsageQueryOptions = (userId: UserId, threadId: ThreadId) =>
  queryOptions({
    queryKey: threadUsageKeys.summary(userId, threadId),
    queryFn: ({ signal }) => getThreadUsage(threadId, signal),
    staleTime: 5_000,
  });

/** One model's requests, newest first, 50 a page. */
export const threadUsageRequestsQueryOptions = (
  userId: UserId,
  threadId: ThreadId,
  providerId: string,
  modelId: string,
) =>
  infiniteQueryOptions({
    queryKey: threadUsageKeys.requests(userId, threadId, providerId, modelId),
    queryFn: ({ pageParam, signal }) =>
      getThreadUsageRequests(
        threadId,
        {
          providerId,
          modelId,
          ...(pageParam === undefined ? {} : { cursor: pageParam }),
        },
        signal,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    staleTime: 30_000,
  });

/** The Thread's Orb runs, newest first, 50 a page. */
export const threadOrbSessionsQueryOptions = (
  userId: UserId,
  threadId: ThreadId,
) =>
  infiniteQueryOptions({
    queryKey: threadUsageKeys.orbSessions(userId, threadId),
    queryFn: ({ pageParam, signal }) =>
      getThreadOrbSessions(threadId, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    staleTime: 30_000,
  });

/** CPU, memory, and disk samples of the Thread's Orb. */
export const threadOrbMetricsQueryOptions = (
  userId: UserId,
  threadId: ThreadId,
) =>
  queryOptions({
    queryKey: threadUsageKeys.orbMetrics(userId, threadId),
    queryFn: ({ signal }) => getThreadOrbMetrics(threadId, signal),
    staleTime: 30_000,
  });
