import type { ThreadId, UserId } from "@dx/domain";
import { MAX_USAGE_RANGE_DAYS } from "@dx/domain";
import { queryOptions } from "@tanstack/react-query";
import { getPersonalUsage } from "../../shared/api/client.js";

const DAY_MS = 86_400_000;

/** The local calendar date of an instant, as usage ranges name days. */
const localDate = (epochMs: number) =>
  new Date(epochMs - new Date(epochMs).getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 10);

/**
 * The owner's estimated model cost for one Thread, from their usage: since
 * the Thread started, or over the longest range usage answers for an older
 * one. Two days short of that range, so a daylight-saving change between
 * its ends cannot push it one day over.
 */
export const threadCostQueryOptions = (
  userId: UserId,
  threadId: ThreadId,
  createdAtMs: number,
) =>
  queryOptions({
    queryKey: ["usage", userId, "thread-cost", threadId] as const,
    queryFn: async ({ signal }) => {
      const now = Date.now();
      const from = Math.max(
        createdAtMs,
        now - (MAX_USAGE_RANGE_DAYS - 2) * DAY_MS,
      );
      const usage = await getPersonalUsage(
        {
          from: localDate(from),
          to: localDate(now),
          timezoneOffsetMinutes: -new Date(now).getTimezoneOffset(),
          threadId,
          limit: 1,
        },
        signal,
      );
      return {
        ...usage.summary.estimatedCost,
        since: from === createdAtMs ? undefined : localDate(from),
      };
    },
    // Read each time the menu opens; the last value shows until then.
    staleTime: 0,
  });
