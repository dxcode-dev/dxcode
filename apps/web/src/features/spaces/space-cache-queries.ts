import type { SpaceData } from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import type { QueryClient } from "@tanstack/react-query";

/**
 * Spaces' query keys and invalidation, without their requests: realtime
 * loads this on the Thread page's first load, and the requests load with the
 * Spaces UI (see `space-queries.ts`).
 */
export const spaceKeys = {
  all: (userId: UserId) => ["spaces", userId] as const,
  /** The Spaces the person created or joined: the sidebar's section. */
  joined: (userId: UserId) => [...spaceKeys.all(userId), "joined"] as const,
  /** Workspace-shared Spaces the person has not joined, for one search. */
  discover: (userId: UserId, query: string) =>
    [...spaceKeys.all(userId), "discover", query.trim()] as const,
  /** New Space's suggestions from the person's recent threads. */
  suggestions: (userId: UserId) =>
    [...spaceKeys.all(userId), "suggestions"] as const,
  detail: (userId: UserId, threadId: ThreadId) =>
    [...spaceKeys.all(userId), "detail", threadId] as const,
  /** The threads a Space started; under its detail key. */
  threads: (userId: UserId, threadId: ThreadId) =>
    [...spaceKeys.detail(userId, threadId), "threads"] as const,
  /** The artifacts of the Space and the threads it started; under its detail key. */
  artifacts: (userId: UserId, threadId: ThreadId) =>
    [...spaceKeys.detail(userId, threadId), "artifacts"] as const,
  /** The Space's chat posts; under its detail key. */
  posts: (userId: UserId, threadId: ThreadId) =>
    [...spaceKeys.detail(userId, threadId), "posts"] as const,
  /** A Space's progress chart, by day in one time zone; under its detail key. */
  progress: (
    userId: UserId,
    threadId: ThreadId,
    days: number,
    timeZone: string,
  ) =>
    [
      ...spaceKeys.detail(userId, threadId),
      "progress",
      days,
      timeZone,
    ] as const,
};

export const invalidateSpaceQueries = (client: QueryClient, userId: UserId) =>
  client.invalidateQueries({ queryKey: spaceKeys.all(userId) });

/**
 * Realtime said a Thread changed. A Space's own Thread refreshes the Space
 * (its name, goal, status), the sidebar's list, and the Space's threads,
 * progress, and artifacts, never its posts, which have their own hint. Any
 * other Thread refreshes the thread list, progress, and artifacts of a Space
 * that lists it or shows its card.
 */
export const invalidateSpaceForThread = (
  client: QueryClient,
  userId: UserId,
  threadId: ThreadId,
) => {
  const known =
    client.getQueryData(spaceKeys.detail(userId, threadId)) !== undefined ||
    client
      .getQueryData<ReadonlyArray<SpaceData>>(spaceKeys.joined(userId))
      ?.some((space) => space.threadId === threadId) === true;
  // A member who does not own the threads a Space started hears of them
  // only through the Space's own Thread, so its threads (their cards among
  // them) and progress refresh with it.
  if (known)
    return Promise.all([
      client.invalidateQueries({
        queryKey: spaceKeys.detail(userId, threadId),
        exact: true,
      }),
      client.invalidateQueries({
        queryKey: spaceKeys.joined(userId),
        exact: true,
      }),
      client.invalidateQueries({
        queryKey: spaceKeys.threads(userId, threadId),
      }),
      client.invalidateQueries({
        queryKey: [...spaceKeys.detail(userId, threadId), "progress"],
      }),
      client.invalidateQueries({
        queryKey: spaceKeys.artifacts(userId, threadId),
      }),
    ]).then(() => undefined);
  const listedBy = (spaceThreadId: ThreadId) =>
    client
      .getQueryData<ReadonlyArray<{ readonly id: string }>>(
        spaceKeys.threads(userId, spaceThreadId),
      )
      ?.some(({ id }) => id === threadId) === true ||
    client.getQueryData([
      ...spaceKeys.threads(userId, spaceThreadId),
      threadId,
    ]) !== undefined ||
    listsArtifactsOf(client, userId, spaceThreadId, threadId);
  const openSpaces = client
    .getQueriesData<ReadonlyArray<{ readonly id: string }>>({
      predicate: ({ queryKey }) =>
        queryKey[0] === "spaces" &&
        queryKey[1] === userId &&
        queryKey[2] === "detail" &&
        queryKey[4] === "threads" &&
        queryKey.length === 5,
    })
    .map(([queryKey]) => queryKey[3] as ThreadId);
  // A Thread no open Space lists yet may be one a Space just started,
  // unless the page already knows it and its parent is another.
  const detail = client.getQueryData<{ readonly parentThreadId?: string }>([
    "threads",
    userId,
    "detail",
    threadId,
  ]);
  const listedAnywhere = openSpaces.some(listedBy);
  const startedBy = (spaceThreadId: ThreadId) =>
    listedBy(spaceThreadId) ||
    (!listedAnywhere &&
      (detail === undefined || detail.parentThreadId === spaceThreadId));
  return client.invalidateQueries({
    predicate: ({ queryKey }) =>
      queryKey[0] === "spaces" &&
      queryKey[1] === userId &&
      queryKey[2] === "detail" &&
      (queryKey[4] === "threads" ||
        queryKey[4] === "progress" ||
        queryKey[4] === "artifacts") &&
      startedBy(queryKey[3] as ThreadId),
  });
};

/** Whether the Space's Artifacts tab lists an artifact of the thread. */
const listsArtifactsOf = (
  client: QueryClient,
  userId: UserId,
  spaceThreadId: ThreadId,
  threadId: ThreadId,
) =>
  client
    .getQueryData<ReadonlyArray<{ readonly thread: { readonly id: string } }>>(
      spaceKeys.artifacts(userId, spaceThreadId),
    )
    ?.some(({ thread }) => thread.id === threadId) === true;

/**
 * Realtime said a Thread's artifacts changed: the Artifacts tab of the
 * Space it is, or of a Space that lists it, reads them again.
 */
export const invalidateSpaceArtifacts = (
  client: QueryClient,
  userId: UserId,
  threadId: ThreadId,
) =>
  client.invalidateQueries({
    predicate: ({ queryKey }) => {
      if (
        queryKey[0] !== "spaces" ||
        queryKey[1] !== userId ||
        queryKey[2] !== "detail" ||
        queryKey[4] !== "artifacts"
      )
        return false;
      const spaceThreadId = queryKey[3] as ThreadId;
      return (
        spaceThreadId === threadId ||
        listsArtifactsOf(client, userId, spaceThreadId, threadId) ||
        client
          .getQueryData<ReadonlyArray<{ readonly id: string }>>(
            spaceKeys.threads(userId, spaceThreadId),
          )
          ?.some(({ id }) => id === threadId) === true
      );
    },
  });

/** Hints for one Space's posts that arrived together refetch them once. */
const POSTS_HINT_WINDOW_MS = 60;
const pendingPostHints = new Map<string, ReturnType<typeof setTimeout>>();
/** Spaces whose posts changed again while their posts were being read. */
const postsChangedWhileReading = new Set<string>();

/**
 * Reads a Space's posts again: after a read under way, if one is (calling
 * it off would only start over), else now.
 */
export const refetchSpacePosts = (
  client: QueryClient,
  userId: UserId,
  threadId: ThreadId,
) => {
  const key = `${userId}:${threadId}`;
  const queryKey = spaceKeys.posts(userId, threadId);
  // A read under way may have started before this change: it finishes,
  // then one more read follows. Calling it off would only start over.
  if (client.isFetching({ queryKey }) > 0) {
    postsChangedWhileReading.add(key);
    return;
  }
  void client
    .invalidateQueries({ queryKey }, { cancelRefetch: false })
    .then(() => {
      if (postsChangedWhileReading.delete(key))
        refetchSpacePosts(client, userId, threadId);
    });
};

/**
 * A Space's posts changed: one was posted or edited, or its reactions. A
 * write sends several hints at once (the post, then dx's `eyes`); they
 * refetch the posts once, a moment after the last. A hint while the posts
 * are being read waits for that read and refetches once after it.
 */
export const invalidateSpacePosts = (
  client: QueryClient,
  userId: UserId,
  threadId: ThreadId,
) => {
  const key = `${userId}:${threadId}`;
  clearTimeout(pendingPostHints.get(key));
  pendingPostHints.set(
    key,
    setTimeout(() => {
      pendingPostHints.delete(key);
      refetchSpacePosts(client, userId, threadId);
    }, POSTS_HINT_WINDOW_MS),
  );
};
