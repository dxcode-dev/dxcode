import type { ThreadData } from "@dx/api";
import type { PageCursor, ProjectId, ThreadId, UserId } from "@dx/domain";
import {
  type InfiniteData,
  type InvalidateOptions,
  infiniteQueryOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import {
  getThread,
  getThreadReadiness,
  listSharedThreads,
  listThreads,
  searchThreads,
  type ThreadListTree,
  type ThreadPage,
} from "../../shared/api/client.js";

const staleTime = 30_000;
const gcTime = 5 * 60_000;
export const THREAD_FRESHNESS_SLO_MS = 60_000;
export const READINESS_FALLBACK_INTERVAL_MS = 5_000;

export const threadKeys = {
  isList: (queryKey: readonly unknown[]) =>
    queryKey[0] === "threads" && queryKey[2] === "list",
  all: (userId: UserId) => ["threads", userId] as const,
  lists: (userId: UserId) => [...threadKeys.all(userId), "list"] as const,
  list: (
    userId: UserId,
    projectId?: ProjectId,
    lifecycleState?: "active" | "archived",
    tree?: ThreadListTree,
  ) =>
    [
      ...threadKeys.lists(userId),
      {
        projectId: projectId ?? null,
        lifecycleState: lifecycleState ?? null,
        tree: tree ?? null,
      },
    ] as const,
  detail: (userId: UserId, threadId: ThreadId) =>
    [...threadKeys.all(userId), "detail", threadId] as const,
  /**
   * Members who can be tagged in a shared Thread. Under the detail key, so
   * every Thread invalidation refreshes it too.
   */
  members: (userId: UserId, threadId: ThreadId) =>
    [...threadKeys.detail(userId, threadId), "members"] as const,
  /** The family tree of a Thread, as its tree page shows it. */
  tree: (userId: UserId, threadId: ThreadId) =>
    [...threadKeys.all(userId), "tree", threadId] as const,
  /** Threads other workspace members shared with this user. */
  shared: (userId: UserId) => [...threadKeys.all(userId), "shared"] as const,
  /** One Thread search query's pages. */
  search: (userId: UserId, query: string) =>
    [...threadKeys.all(userId), "search", query] as const,
};

export const invalidateAllThreadQueries = (
  client: QueryClient,
  userId: UserId,
) => client.invalidateQueries({ queryKey: threadKeys.all(userId) });

/**
 * How many child Threads a loaded sidebar list counts under this Thread;
 * zero when none does. Only a root's row carries the count.
 */
export const listedChildCount = (
  client: QueryClient,
  userId: UserId,
  threadId: ThreadId,
) => {
  for (const [, data] of client.getQueriesData<
    InfiniteData<ThreadPage, unknown>
  >({ queryKey: threadKeys.lists(userId) }))
    for (const page of data?.pages ?? [])
      for (const item of page.items)
        if (item.id === threadId && item.childCount !== undefined)
          return item.childCount;
  return 0;
};

export const invalidateThreadLists = (
  client: QueryClient,
  userId: UserId,
  options?: InvalidateOptions,
) =>
  Promise.all([
    client.invalidateQueries({ queryKey: threadKeys.lists(userId) }, options),
    client.invalidateQueries({ queryKey: threadKeys.shared(userId) }, options),
  ]);

export const invalidateThreadQueries = async (
  client: QueryClient,
  userId: UserId,
  threadId: ThreadId,
) => {
  await Promise.all([
    invalidateThreadLists(client, userId),
    client.invalidateQueries({ queryKey: threadKeys.detail(userId, threadId) }),
  ]);
};

export const invalidateReadinessQuery = (
  client: QueryClient,
  userId: UserId,
  threadId: ThreadId,
) =>
  client.invalidateQueries({
    queryKey: threadKeys.detail(userId, threadId),
  });

export const threadsQueryOptions = (
  userId: UserId,
  projectId?: ProjectId,
  lifecycleState?: "active" | "archived",
  tree?: ThreadListTree,
) =>
  infiniteQueryOptions({
    queryKey: threadKeys.list(userId, projectId, lifecycleState, tree),
    queryFn: ({ pageParam, signal }) =>
      listThreads(projectId, pageParam, signal, lifecycleState, tree),
    initialPageParam: undefined as PageCursor | undefined,
    getNextPageParam: (page) => page.nextCursor,
    staleTime,
    gcTime,
    refetchInterval: THREAD_FRESHNESS_SLO_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
  });

type ThreadDetail = Awaited<ReturnType<typeof getThread>>;

/**
 * The full detail, or only readiness while the workspace prepares under a
 * settled title.
 */
const readThread = async (
  {
    client,
    queryKey,
    signal,
  }: {
    readonly client: QueryClient;
    readonly queryKey: readonly unknown[];
    readonly signal: AbortSignal;
  },
  threadId: ThreadId,
): Promise<ThreadDetail> => {
  const current = client.getQueryData<ThreadDetail>(queryKey);
  // A pending title settles only through the full detail payload.
  if (
    current?.executionWorkspace.ready === false &&
    current.titlePending !== true
  ) {
    const executionWorkspace = await getThreadReadiness(threadId, signal);
    // Readiness polling deliberately avoids the larger detail payload, but the
    // transition is also the point where workspace-derived detail becomes
    // authoritative. Do not leave the pre-ready snapshot in cache.
    if (executionWorkspace.ready) return getThread(threadId, signal);
    return { ...current, executionWorkspace };
  }
  return getThread(threadId, signal);
};

/**
 * A settled title the detail read, for list rows still showing the title
 * pending. Its realtime hint can be lost, or its list refetch cancelled by
 * the Thread's creation, so the sidebar would show the dots while the title
 * bar shows the title. A pending title never returns, so this is never older.
 */
const settleListedTitle = (
  client: QueryClient,
  userId: UserId,
  thread: Pick<ThreadData, "id" | "title" | "titlePending">,
) => {
  if (thread.titlePending === true) return;
  const settle = <Row extends ThreadData>(row: Row): Row => {
    if (row.id !== thread.id || row.titlePending !== true) return row;
    const { titlePending: _pending, ...settled } = row;
    return { ...settled, title: thread.title } as Row;
  };
  for (const query of client
    .getQueryCache()
    .findAll({ queryKey: threadKeys.lists(userId) })) {
    const data = query.state.data as
      | InfiniteData<ThreadPage, unknown>
      | undefined;
    if (
      data?.pages.some((page) =>
        [...page.items, ...(page.children ?? [])].some(
          (row) => row.id === thread.id && row.titlePending === true,
        ),
      ) !== true
    )
      continue;
    // Kept as fetched then, so the list's own refetch stays due.
    client.setQueryData<InfiniteData<ThreadPage, unknown>>(
      query.queryKey,
      {
        ...data,
        pages: data.pages.map((page) => ({
          ...page,
          items: page.items.map(settle),
          ...(page.children === undefined
            ? {}
            : { children: page.children.map(settle) }),
        })),
      },
      { updatedAt: query.state.dataUpdatedAt },
    );
  }
};

export const threadQueryOptions = (userId: UserId, threadId: ThreadId) =>
  queryOptions({
    queryKey: threadKeys.detail(userId, threadId),
    queryFn: async (context) => {
      const thread = await readThread(context, threadId);
      settleListedTitle(context.client, userId, thread);
      return thread;
    },
    staleTime,
    gcTime,
    refetchInterval: (query) =>
      query.state.data?.executionWorkspace.ready === false ||
      query.state.data?.titlePending === true
        ? READINESS_FALLBACK_INTERVAL_MS
        : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });

/**
 * Thread search pages for one query. Each keystroke is debounced by the
 * caller; results stay cached briefly so going back to a query is free.
 */
export const threadSearchQueryOptions = (userId: UserId, query: string) =>
  infiniteQueryOptions({
    queryKey: threadKeys.search(userId, query),
    queryFn: ({ pageParam, signal }) => searchThreads(query, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor,
    staleTime,
    gcTime,
    retry: false,
  });

export const sharedThreadsQueryOptions = (userId: UserId) =>
  queryOptions({
    queryKey: threadKeys.shared(userId),
    queryFn: ({ signal }) => listSharedThreads(signal),
    staleTime,
    gcTime,
    refetchInterval: THREAD_FRESHNESS_SLO_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
  });
