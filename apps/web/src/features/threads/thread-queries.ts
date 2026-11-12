import type { ThreadData, ThreadDetailData } from "@dx/api";
import type { PageCursor, ProjectId, ThreadId, UserId } from "@dx/domain";
import {
  type InfiniteData,
  type InvalidateOptions,
  infiniteQueryOptions,
  type MutationFilters,
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
import { retryOnMountQuery } from "../../shared/query/query-retry.js";
import { prefetchThreadHistory } from "../../shared/same-origin-fetch.js";

const staleTime = 30_000;
const gcTime = 5 * 60_000;
export const THREAD_FRESHNESS_SLO_MS = 60_000;
export const READINESS_FALLBACK_INTERVAL_MS = 5_000;
/**
 * How often a Thread whose first message is still on its way to the agent
 * re-reads its detail; it usually arrives within two seconds (#1590).
 */
const INITIAL_DISPATCH_POLL_INTERVAL_MS = 1_500;

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
  /** Threads other workspace members shared with this user. */
  shared: (userId: UserId) => [...threadKeys.all(userId), "shared"] as const,
  /** One Thread search query's pages. */
  search: (userId: UserId, query: string) =>
    [...threadKeys.all(userId), "search", query] as const,
};

/**
 * An archive or restore of the Thread the server has not answered yet.
 * Until it answers, the cached lifecycle is only what the page expects.
 */
export const threadArchiveInFlight = (
  userId: UserId,
  threadId: ThreadId,
): MutationFilters => ({
  mutationKey: threadKeys.all(userId),
  status: "pending",
  predicate: (mutation) => {
    const kind = mutation.options.mutationKey?.[2];
    const variables = mutation.state.variables as
      | {
          readonly threadId?: ThreadId;
          readonly threadIds?: ReadonlyArray<ThreadId>;
        }
      | undefined;
    return (
      (kind === "archive" || kind === "archive-many") &&
      (variables?.threadId === threadId ||
        variables?.threadIds?.includes(threadId) === true)
    );
  },
});

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

/**
 * A Project's active Threads as the sidebar's cached list already holds them,
 * shown while the Project's own list loads (#1440). The sidebar lists root
 * Threads only, so the Project's own read adds its child Threads.
 */
export const sidebarProjectThreads = (
  client: QueryClient,
  userId: UserId,
  projectId: ProjectId,
) => {
  const sidebar = client.getQueryData<InfiniteData<ThreadPage>>(
    threadKeys.list(userId, undefined, "active", "roots"),
  );
  const items = sidebar?.pages.flatMap((page) =>
    page.items.filter((thread) => thread.projectId === projectId),
  );
  return items === undefined || items.length === 0
    ? undefined
    : { pages: [{ items }], pageParams: [undefined] };
};

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
      // A first message the agent has not admitted yet may still fail.
      query.state.data?.initialDispatch?.state === "pending"
        ? INITIAL_DISPATCH_POLL_INTERVAL_MS
        : // A Space's own Thread runs without an Orb, so its workspace never
          // becomes ready: reading its readiness every few seconds would
          // only cost requests for as long as the Space stays open.
          (query.state.data?.executionWorkspace.ready === false &&
              query.state.data.kind !== "space") ||
            query.state.data?.titlePending === true
          ? READINESS_FALLBACK_INTERVAL_MS
          : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    // A Thread the server refused while the page booted (hidden or missing)
    // is not read again when the page mounts.
    retryOnMount: retryOnMountQuery,
  });

/**
 * Starts the reads a Thread's page waits on, the Thread and its first
 * history page, when the person shows intent to open it: hovering or
 * pressing its link preloads the route (#1438). Reads already cached and
 * fresh are not repeated.
 */
export const prefetchThreadOpen = (
  client: QueryClient,
  userId: UserId,
  threadId: ThreadId,
) => {
  // A Thread this tab created or already opened holds its detail, and its
  // conversation is retained or told by the creation: no history to read.
  const known =
    client.getQueryData(threadKeys.detail(userId, threadId)) !== undefined;
  void client.prefetchQuery(threadQueryOptions(userId, threadId));
  if (!known) prefetchThreadHistory(threadId);
};

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

/**
 * Whether the page last saw the Thread working: a turn running, with any
 * messages queued behind it. Archiving stops both (#1668).
 */
export const threadSeenWorking = (
  client: QueryClient,
  userId: UserId,
  threadId: ThreadId,
) => {
  const detail = client.getQueryData<ThreadDetailData>(
    threadKeys.detail(userId, threadId),
  );
  if (detail !== undefined) return detail.activityStatus === "working";
  return client
    .getQueriesData<InfiniteData<ThreadPage, unknown>>({
      queryKey: threadKeys.lists(userId),
    })
    .some(([, data]) =>
      data?.pages.some((page) =>
        [...page.items, ...(page.children ?? [])].some(
          (row) => row.id === threadId && row.activityStatus === "working",
        ),
      ),
    );
};

/**
 * Installed plugins' UI in one Thread: prompts waiting on a person, recent
 * notices, quick actions, palette commands, and link patterns as a remark
 * plugin for the transcript. On the Thread page's first load, so the page
 * reads link patterns and realtime refreshes it; the request, its schemas,
 * and the remark plugin load with the first fetch, after the page paints.
 */
export const pluginUiQueryOptions = (threadId: ThreadId) =>
  queryOptions({
    queryKey: ["plugin-ui", threadId] as const,
    queryFn: ({ signal }) =>
      import("./plugin-ui/plugin-ui-fetch-queries.js").then((module) =>
        module.loadPluginUi(threadId, signal),
      ),
    // The remark plugin is a function, not JSON: keep it as returned.
    structuralSharing: false,
    staleTime: 30_000,
    retry: 1,
    refetchOnWindowFocus: true,
  });

/** The Thread's link patterns as a remark plugin, or null without any. */
export const pluginLinkRemarkQueryOptions = (threadId: ThreadId) =>
  queryOptions({
    ...pluginUiQueryOptions(threadId),
    select: (data) => data.linkRemark,
  });

/** `plugin-ui.invalidated`: a plugin's prompt, notice, or action changed. */
export const invalidatePluginUi = (client: QueryClient, threadId: ThreadId) =>
  client.invalidateQueries({ queryKey: ["plugin-ui", threadId] });

/** The query key of a Thread's plugin panes' posts. */
export const pluginPaneMessagesKey = (threadId: ThreadId) =>
  ["plugin-pane", threadId] as const;

/** `plugin-pane.invalidated`: a plugin posted to one of its panes. */
export const invalidatePluginPaneMessages = (
  client: QueryClient,
  threadId: ThreadId,
) => client.invalidateQueries({ queryKey: pluginPaneMessagesKey(threadId) });
