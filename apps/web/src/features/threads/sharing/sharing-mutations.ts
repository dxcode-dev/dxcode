import type {
  ThreadConversationMode,
  ThreadData,
  ThreadDetailData,
  UpdateThreadSharingRequest,
  UpdateThreadSharingResponseData,
} from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import {
  MutationObserver,
  type QueryClient,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import {
  ApiError,
  setThreadFollowing,
  updateThreadSharing,
} from "../../../shared/api/client.js";
import {
  invalidateThreadQueries,
  threadKeys,
  threadQueryOptions,
} from "../thread-queries.js";

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

/**
 * The server held a share back because the family's agents read Mail
 * mail its viewers would see; the owner confirms, then shares again with
 * `acknowledgeMailReads`.
 */
export const isMailReadsRefusal = (error: unknown): error is ApiError =>
  error instanceof ApiError && error.code === "THREAD_SHARING_MAIL_READS";

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
const threadFollowingMutationOptions = (
  client: QueryClient,
  userId: UserId,
  threadId: ThreadId,
) => ({
  mutationKey: ["threads", userId, "follow", threadId],
  mutationFn: (following: boolean) => setThreadFollowing(threadId, following),
  onSuccess: async ({ following }: { readonly following: boolean }) => {
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

export const useSetThreadFollowing = (userId: UserId, threadId: ThreadId) => {
  const client = useQueryClient();
  return useMutation(threadFollowingMutationOptions(client, userId, threadId));
};

/**
 * Opening another member's shared Thread follows it. The Thread route calls
 * this on entering a Thread, once its detail says who it belongs to.
 */
export const followOpenedThread = async (
  client: QueryClient,
  userId: UserId,
  threadId: ThreadId,
) => {
  const thread = await client
    .ensureQueryData(threadQueryOptions(userId, threadId))
    .catch(() => undefined);
  if (
    thread === undefined ||
    thread.access === undefined ||
    thread.access === "owner" ||
    thread.following !== false
  )
    return;
  await new MutationObserver(
    client,
    threadFollowingMutationOptions(client, userId, threadId),
  )
    .mutate(true)
    .catch(() => undefined);
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
