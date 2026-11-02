import {
  type NeedsYouData,
  type NeedsYouRankingData,
  NeedsYouRankingResponseSchema,
} from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import {
  dismissNeedsYou,
  listNeedsYou,
  request,
} from "../../shared/api/client.js";

export const needsYouKeys = {
  list: (userId: UserId) => ["needs-you", userId] as const,
  ranking: (userId: UserId) => ["needs-you-ranking", userId] as const,
};

/**
 * The person's Threads that wait on them. Realtime `needs-you.invalidated`
 * refetches it when one starts or stops waiting; the interval is the
 * fallback while the socket is down.
 */
export const needsYouQueryOptions = (userId: UserId) =>
  queryOptions({
    queryKey: needsYouKeys.list(userId),
    queryFn: ({ signal }) => listNeedsYou(signal),
    staleTime: 30_000,
    gcTime: 10 * 60_000,
    refetchInterval: 120_000,
    refetchOnWindowFocus: true,
  });

export const invalidateNeedsYou = (client: QueryClient, userId: UserId) =>
  client.invalidateQueries({ queryKey: needsYouKeys.list(userId) });

/** Dismisses one Thread's ask; the row leaves the list at once. */
export const dismissNeedsYouMutationOptions = (
  client: QueryClient,
  userId: UserId,
) =>
  mutationOptions({
    mutationKey: [...needsYouKeys.list(userId), "dismiss"] as const,
    mutationFn: (threadId: ThreadId) => dismissNeedsYou(threadId),
    onMutate: async (threadId) => {
      await client.cancelQueries({ queryKey: needsYouKeys.list(userId) });
      client.setQueryData<NeedsYouData>(needsYouKeys.list(userId), (current) =>
        current === undefined
          ? current
          : {
              items: current.items.filter((item) => item.threadId !== threadId),
            },
      );
    },
    onSuccess: (data) => {
      client.setQueryData(needsYouKeys.list(userId), data);
    },
    onError: () => invalidateNeedsYou(client, userId),
  });

/** Prioritize: the person's saved ranking and the models it can run on. */
const getNeedsYouRanking = async (signal?: AbortSignal) =>
  (
    await request("/v1/needs-you/ranking", NeedsYouRankingResponseSchema, {
      signal,
    })
  ).data;

/** Ranks what waits on the person now; one model call, 10 to 30 seconds. */
const rankNeedsYou = async (model: string | undefined) =>
  (
    await request("/v1/needs-you/ranking", NeedsYouRankingResponseSchema, {
      method: "POST",
      body: JSON.stringify(model === undefined ? {} : { model }),
    })
  ).data;

/** Read only while the `needs-you-prioritize` flag is on. */
export const needsYouRankingQueryOptions = (userId: UserId, enabled: boolean) =>
  queryOptions({
    queryKey: needsYouKeys.ranking(userId),
    queryFn: ({ signal }) => getNeedsYouRanking(signal),
    enabled,
    staleTime: 60_000,
    gcTime: 10 * 60_000,
  });

/** Prioritize and Re-rank: the saved ranking replaces the shown one. */
export const rankNeedsYouMutationOptions = (
  client: QueryClient,
  userId: UserId,
) =>
  mutationOptions({
    mutationKey: [...needsYouKeys.ranking(userId), "rank"] as const,
    mutationFn: (model: string | undefined) => rankNeedsYou(model),
    onSuccess: (data: NeedsYouRankingData) => {
      client.setQueryData(needsYouKeys.ranking(userId), data);
    },
  });
