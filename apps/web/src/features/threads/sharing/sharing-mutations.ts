import type {
  ThreadConversationMode,
  ThreadData,
  ThreadDetailData,
  UpdateThreadSharingRequest,
  UpdateThreadSharingResponseData,
} from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import {
  type QueryClient,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import {
  setThreadFollowing,
  updateThreadSharing,
} from "../../../shared/api/client.js";
import { invalidateThreadQueries, threadKeys } from "../thread-queries.js";

const applySharing = (
  client: QueryClient,
  userId: UserId,
  threadId: ThreadId,
  result: UpdateThreadSharingResponseData,
) =>
  client.setQueryData<ThreadDetailData>(
    threadKeys.detail(userId, threadId),
    (current) => {
      if (current === undefined) return current;
      const { sharing: _previous, ...rest } = current;
      return {
        ...rest,
        visibility: result.sharing === undefined ? "private" : "workspace",
        ...(result.sharing === undefined ? {} : { sharing: result.sharing }),
        skipMultiplayerConfirmation: result.skipMultiplayerConfirmation,
      };
    },
  );

/** The owner changes who in the workspace can see or use a Thread. */
export const useUpdateThreadSharing = (userId: UserId, threadId: ThreadId) => {
  const client = useQueryClient();
  return useMutation({
    mutationKey: ["threads", userId, "sharing", threadId],
    mutationFn: (input: UpdateThreadSharingRequest) =>
      updateThreadSharing(threadId, input),
    onSuccess: async (result) => {
      applySharing(client, userId, threadId, result);
      await invalidateThreadQueries(client, userId, threadId);
    },
  });
};

/**
 * A member follows or unfollows a shared Thread: followed Threads show in
 * their sidebar under the Thread's Project.
 */
export const useSetThreadFollowing = (userId: UserId, threadId: ThreadId) => {
  const client = useQueryClient();
  return useMutation({
    mutationKey: ["threads", userId, "follow", threadId],
    mutationFn: (following: boolean) => setThreadFollowing(threadId, following),
    onSuccess: async ({ following }) => {
      client.setQueryData<ThreadDetailData>(
        threadKeys.detail(userId, threadId),
        (current) =>
          current === undefined || current.access === "owner"
            ? current
            : { ...current, following },
      );
      await client.invalidateQueries({ queryKey: threadKeys.shared(userId) });
    },
  });
};

/** Shows the mode a message switched the Thread to before realtime does. */
export const setConversationMode = (
  client: QueryClient,
  userId: UserId,
  threadId: ThreadId,
  conversationMode: ThreadConversationMode,
) =>
  client.setQueryData<ThreadDetailData>(
    threadKeys.detail(userId, threadId),
    (current) =>
      current === undefined || current.sharing === undefined
        ? current
        : { ...current, conversationMode },
  );

/** Unfollowing from the sidebar removes the Thread from it at once. */
export const unfollowThreadMutationOptions = (
  client: QueryClient,
  userId: UserId,
) => ({
  mutationKey: ["threads", userId, "unfollow"],
  mutationFn: (threadId: ThreadId) => setThreadFollowing(threadId, false),
  onMutate: (threadId: ThreadId) => {
    client.setQueryData<ReadonlyArray<ThreadData>>(
      threadKeys.shared(userId),
      (current) => current?.filter(({ id }) => id !== threadId),
    );
  },
  onSettled: (_result: unknown, _error: unknown, threadId: ThreadId) =>
    Promise.all([
      client.invalidateQueries({ queryKey: threadKeys.shared(userId) }),
      client.invalidateQueries({
        queryKey: threadKeys.detail(userId, threadId),
      }),
    ]),
});
