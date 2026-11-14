import {
  type SpaceCatchUp,
  SpaceCatchUpResponseSchema,
  type SpaceThreadItem,
  SpaceThreadResponseSchema,
} from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { request } from "../../../shared/api/client.js";
import { spaceKeys } from "../space-cache-queries.js";
import { spaceThreadsQueryOptions } from "../space-queries.js";

const path = (spaceThreadId: ThreadId, rest: string) =>
  `/v1/spaces/${encodeURIComponent(spaceThreadId)}${rest}`;

export const spaceCardKeys = {
  /** One thread's card; under the Space's thread list, which it refreshes with. */
  thread: (userId: UserId, spaceThreadId: ThreadId, threadId: string) =>
    [...spaceKeys.threads(userId, spaceThreadId), threadId] as const,
  catchUp: (userId: UserId, spaceThreadId: ThreadId) =>
    [...spaceKeys.detail(userId, spaceThreadId), "catch-up"] as const,
};

const getSpaceThread = async (
  spaceThreadId: ThreadId,
  threadId: string,
  signal?: AbortSignal,
): Promise<SpaceThreadItem> =>
  (
    await request(
      path(spaceThreadId, `/threads/${encodeURIComponent(threadId)}`),
      SpaceThreadResponseSchema,
      { signal },
    )
  ).data.item;

/**
 * One thread's card: from the Space's thread list, which every card shares
 * and realtime refreshes, or read alone while the list does not have it yet,
 * such as a thread started a moment ago. Undefined while it loads; null when
 * the Space has no such thread, such as one another thread started.
 */
export const useSpaceThreadItem = (
  userId: UserId,
  spaceThreadId: ThreadId | undefined,
  threadId: string,
) => {
  const list = useQuery({
    ...spaceThreadsQueryOptions(userId, (spaceThreadId ?? "") as ThreadId),
    enabled: spaceThreadId !== undefined,
    select: (items) => items.find(({ id }) => id === threadId) ?? null,
  });
  const single = useQuery({
    queryKey: spaceCardKeys.thread(
      userId,
      (spaceThreadId ?? "") as ThreadId,
      threadId,
    ),
    queryFn: ({ signal }) =>
      getSpaceThread(spaceThreadId as ThreadId, threadId, signal),
    enabled: spaceThreadId !== undefined && list.data === null,
    retry: false,
    // A card that gives way to the thread's chip mounts another reader of
    // this query: an answer that the Space has no such thread stands until
    // the list refreshes, instead of each new reader asking again.
    retryOnMount: false,
    staleTime: 30_000,
  });
  if (list.data != null) return list.data;
  if (single.data !== undefined) return single.data;
  // Once refused, it stays so while a refresh asks again.
  return list.data === null && single.errorUpdateCount > 0 ? null : undefined;
};

const getCatchUp = async (
  spaceThreadId: ThreadId,
  signal?: AbortSignal,
): Promise<SpaceCatchUp | null> =>
  (
    await request(
      path(spaceThreadId, "/catch-up"),
      SpaceCatchUpResponseSchema,
      { signal },
    )
  ).data.catchUp;

/** How often an open Space tells Core it is still being watched. */
const VISIT_HEARTBEAT_MS = 10 * 60_000;

/**
 * The person's "Since you've been gone" card. Each read also records that
 * they have the Space open, so it reads again while the Space stays visible
 * and when the window regains focus.
 */
export const spaceCatchUpQueryOptions = (
  userId: UserId,
  spaceThreadId: ThreadId,
) =>
  queryOptions({
    queryKey: spaceCardKeys.catchUp(userId, spaceThreadId),
    queryFn: ({ signal }) => getCatchUp(spaceThreadId, signal),
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    refetchInterval: VISIT_HEARTBEAT_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: "always",
    retry: false,
  });

export const useDismissCatchUp = (userId: UserId, spaceThreadId: ThreadId) => {
  const client = useQueryClient();
  return useMutation({
    mutationKey: [...spaceCardKeys.catchUp(userId, spaceThreadId), "dismiss"],
    mutationFn: async () => {
      await request(
        path(spaceThreadId, "/catch-up/dismiss"),
        SpaceCatchUpResponseSchema,
        { method: "POST" },
      );
    },
    onMutate: () => {
      client.setQueryData(spaceCardKeys.catchUp(userId, spaceThreadId), null);
    },
  });
};
