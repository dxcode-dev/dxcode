import { type SpaceProgressData, SpaceProgressResponseSchema } from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import { queryOptions } from "@tanstack/react-query";
import { request } from "../../../shared/api/client.js";
import { THREAD_FRESHNESS_SLO_MS } from "../../threads/thread-queries.js";
import { spaceKeys } from "../space-cache-queries.js";

/** The chart's window: the last 30 days, today included. */
export const SPACE_PROGRESS_DAYS = 30;

/** The viewer's IANA time zone, which the chart's days are counted in. */
export const viewerTimeZone = () =>
  Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

const getSpaceProgress = async (
  threadId: ThreadId,
  days: number,
  timeZone: string,
  signal?: AbortSignal,
): Promise<SpaceProgressData> =>
  (
    await request(
      `/v1/spaces/${encodeURIComponent(threadId)}/progress?days=${days}&tz=${encodeURIComponent(timeZone)}`,
      SpaceProgressResponseSchema,
      { signal },
    )
  ).data;

/**
 * A Space's threads by day. Realtime refreshes it when the Space or any
 * Thread changes (`invalidateSpaceForThread`); the interval moves it to a
 * new day.
 */
export const spaceProgressQueryOptions = (
  userId: UserId,
  threadId: ThreadId,
  timeZone: string,
  days = SPACE_PROGRESS_DAYS,
) =>
  queryOptions({
    queryKey: spaceKeys.progress(userId, threadId, days, timeZone),
    queryFn: ({ signal }) => getSpaceProgress(threadId, days, timeZone, signal),
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    refetchInterval: THREAD_FRESHNESS_SLO_MS,
    refetchIntervalInBackground: false,
  });
