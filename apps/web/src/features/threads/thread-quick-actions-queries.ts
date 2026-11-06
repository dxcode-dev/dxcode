import { ThreadQuickActionsResponseSchema } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { queryOptions } from "@tanstack/react-query";
import { request } from "../../shared/api/client.js";

const getThreadQuickActions = async (
  threadId: ThreadId,
  messageId: string,
  signal?: AbortSignal,
) =>
  (
    await request(
      `/v1/threads/${encodeURIComponent(threadId)}/quick-actions?messageId=${encodeURIComponent(messageId)}`,
      ThreadQuickActionsResponseSchema,
      { signal },
    )
  ).data;

/** How often, and how many times, to ask again while the pick is pending. */
const PENDING_POLL_MS = 1_500;
const PENDING_POLLS = 20;

/**
 * What Clef Flash picked to show above the composer after the agent's
 * message `messageId`. The server picks once, when the agent's turn ends,
 * and keeps the pick, so a reload asks no model. Until that pick is in,
 * the answer is `pending` and the page asks again every 1.5 seconds, for
 * at most 30 seconds. A settled answer never changes, while a newer
 * message is a new key. It loads after the composer has painted; a failure
 * shows no row, so it does not retry.
 */
export const threadQuickActionsQueryOptions = (
  threadId: ThreadId,
  messageId: string,
) =>
  queryOptions({
    queryKey: ["threads", threadId, "quick-actions", messageId] as const,
    queryFn: ({ signal }) => getThreadQuickActions(threadId, messageId, signal),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 10 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: (query) =>
      query.state.data?.pending === true &&
      query.state.dataUpdateCount < PENDING_POLLS
        ? PENDING_POLL_MS
        : false,
  });
