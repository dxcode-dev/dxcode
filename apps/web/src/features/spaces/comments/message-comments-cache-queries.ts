import type { ThreadId, UserId } from "@dx/domain";
import type { QueryClient } from "@tanstack/react-query";
import { refetchSpacePosts } from "../space-cache-queries.js";

/**
 * A Space's message comments' query keys and invalidation, without their
 * requests: realtime loads this on the Thread page's first load, and the
 * requests load with the comments UI (`message-comments-queries.ts`).
 */
export const messageCommentKeys = {
  all: (userId: UserId) => ["message-comments", userId] as const,
  thread: (userId: UserId, threadId: ThreadId) =>
    [...messageCommentKeys.all(userId), threadId] as const,
  /** Every commented message of the Space, one summary each. */
  summaries: (userId: UserId, threadId: ThreadId) =>
    [...messageCommentKeys.thread(userId, threadId), "summaries"] as const,
  /** One message's comments. */
  message: (userId: UserId, threadId: ThreadId, messageId: string) =>
    [
      ...messageCommentKeys.thread(userId, threadId),
      "message",
      messageId,
    ] as const,
};

/**
 * Someone commented in this Space: refetch what the page shows of it, the
 * comments and the posts' replies rows.
 */
export const invalidateMessageComments = (
  client: QueryClient,
  userId: UserId,
  threadId: ThreadId,
) =>
  Promise.all([
    client.invalidateQueries({
      queryKey: messageCommentKeys.thread(userId, threadId),
    }),
    // The posts' replies rows; a posts read under way finishes first.
    refetchSpacePosts(client, userId, threadId),
  ]).then(() => undefined);

export const invalidateAllMessageComments = (
  client: QueryClient,
  userId: UserId,
) => client.invalidateQueries({ queryKey: messageCommentKeys.all(userId) });
