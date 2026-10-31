import type { NeedsYouData } from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { dismissNeedsYou, listNeedsYou } from "../../shared/api/client.js";

export const needsYouKeys = {
  list: (userId: UserId) => ["needs-you", userId] as const,
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
