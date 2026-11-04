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

/**
 * What Clef Flash picked to show above the composer after the agent's
 * message `messageId`. One model call per agent message: the server keeps
 * each pick, so a reload asks no model, and here the answer for a message
 * never changes while a newer message is a new key. It loads after the
 * composer has painted; a failure shows no row, so it does not retry.
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
  });
