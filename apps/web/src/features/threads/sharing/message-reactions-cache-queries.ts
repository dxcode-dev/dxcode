import type { ThreadId, UserId } from "@dx/domain";
import type { QueryClient } from "@tanstack/react-query";

/**
 * A shared Thread's message reactions' query key and invalidation, without
 * their requests: realtime loads this on the Thread page's first load.
 */
export const messageReactionKeys = {
  thread: (userId: UserId, threadId: ThreadId) =>
    ["message-reactions", userId, threadId] as const,
};

/** `reactions.invalidated`: someone reacted; refetch the Thread's reactions. */
export const invalidateMessageReactions = (
  client: QueryClient,
  userId: UserId,
  threadId: ThreadId,
) =>
  client.invalidateQueries({
    queryKey: messageReactionKeys.thread(userId, threadId),
  });
