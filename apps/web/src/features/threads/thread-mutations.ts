import type {
  InitialThreadMessage,
  ProjectData,
  ThreadData,
  ThreadDetailData,
  ThreadListItem,
  UpdateThreadRequest,
} from "@dx/api";
import { CreateThreadResponseSchema, threadAgentUrl } from "@dx/api";
import type {
  ProjectId,
  RunnerProfileId,
  ThreadId,
  ThreadModelSelection,
  ThreadTitle,
  ThreadVisibility,
  UserId,
} from "@dx/domain";
import {
  type InfiniteData,
  mutationOptions,
  notifyManager,
  type QueryClient,
} from "@tanstack/react-query";
import { DateTime } from "effect";
import {
  ApiError,
  type ArchivedThread,
  deleteThread,
  request,
  retryInitialDispatch,
  setThreadArchived,
  setThreadPinned,
  setThreadSnoozed,
  type ThreadPage,
  updateThread,
} from "../../shared/api/client.js";
import { seedProjectDetail } from "../projects/project-mutations.js";
import { belongsInLoadedList, listOrder } from "./thread-list-order-queries.js";
import { invalidateThreadQueries, threadKeys } from "./thread-queries.js";

type ThreadListData = InfiniteData<ThreadPage, unknown>;
const optimisticCreation = "__dxOptimisticCreation" as const;

/** Changes a list page's Threads, both its roots and the children they carry. */
const flatMapListedThreads = (
  page: ThreadPage,
  change: (
    thread: ThreadPage["items"][number],
  ) => ReadonlyArray<ThreadPage["items"][number]>,
): ThreadPage => ({
  ...page,
  items: page.items.flatMap(change),
  ...(page.children === undefined
    ? {}
    : { children: page.children.flatMap(change) }),
});

const createThread = async (
  projectId: ProjectId | undefined,
  title: ThreadTitle,
  selection?: ThreadModelSelection,
  runnerProfileId?: RunnerProfileId,
  initialMessage?: InitialThreadMessage,
  threadId?: ThreadId,
  signal?: AbortSignal,
  claudeConnectionId?: string,
  visibility?: ThreadVisibility,
): Promise<typeof CreateThreadResponseSchema.Type> =>
  request("/v1/threads", CreateThreadResponseSchema, {
    method: "POST",
    ...(signal === undefined ? {} : { signal }),
    body: JSON.stringify({
      ...(projectId === undefined ? {} : { projectId }),
      title,
      ...(selection === undefined ? {} : { selection }),
      ...(runnerProfileId === undefined ? {} : { runnerProfileId }),
      ...(initialMessage === undefined ? {} : { initialMessage }),
      ...(threadId === undefined ? {} : { threadId }),
      ...(claudeConnectionId === undefined ? {} : { claudeConnectionId }),
      ...(visibility === undefined ? {} : { visibility }),
    }),
  });

export type OptimisticThreadData = ThreadData & {
  readonly [optimisticCreation]: true;
};

/** A Thread the server has not admitted yet; the sidebar shows it creating. */
export const isOptimisticThread = (
  thread: ThreadData,
): thread is OptimisticThreadData => optimisticCreation in thread;

export const optimisticThreadData = (
  id: ThreadId,
  projectId: ProjectId,
  title: ThreadTitle,
  startedAt: number,
): OptimisticThreadData => {
  const at = DateTime.makeUnsafe(startedAt);
  return {
    id,
    projectId,
    title,
    visibility: "private",
    createdAt: at,
    updatedAt: at,
    lastActivityAt: at,
    activityStatus: "idle",
    lifecycleState: "active",
    agentUrl: threadAgentUrl(id),
    [optimisticCreation]: true,
  };
};

const matchingActiveList = (
  queryKey: readonly unknown[],
  projectId: ProjectId,
) => {
  const scope = queryKey[3] as
    | {
        readonly projectId: ProjectId | null;
        readonly lifecycleState?: "active" | "archived" | null;
        readonly tree?: string | null;
      }
    | undefined;
  // A Thread created here is a root; it never joins a parent's children.
  return (
    scope?.lifecycleState !== "archived" &&
    (scope?.tree == null || scope.tree === "roots") &&
    (scope?.projectId === null || scope?.projectId === projectId)
  );
};

const createdThreadListItem = (
  thread: ThreadDetailData,
  projectless: boolean,
): ThreadListItem => ({
  ...thread,
  ...(projectless ? { projectless: true as const } : {}),
  mode:
    thread.agentInitialization.selection.kind === "mode"
      ? thread.agentInitialization.selection.mode
      : thread.agentInitialization.selection.model,
});

/**
 * A title that settled while creation was in flight is newer than the
 * creation response's pending snapshot; keep it.
 */
const withSettledTitle = <Cached extends ThreadData>(
  created: Cached,
  cached: ThreadData | undefined,
): Cached => {
  if (
    created.titlePending !== true ||
    cached === undefined ||
    isOptimisticThread(cached) ||
    cached.titlePending === true
  )
    return created;
  const { titlePending: _pending, ...settled } = created;
  return { ...settled, title: cached.title } as Cached;
};

export const cacheCreatedThread = (
  queryClient: QueryClient,
  userId: UserId,
  thread: ThreadDetailData,
  /** Created in No Project, which the detail does not say. */
  projectless = false,
) =>
  Promise.all([
    queryClient.cancelQueries({
      queryKey: threadKeys.detail(userId, thread.id),
      exact: true,
    }),
    queryClient.cancelQueries({ queryKey: threadKeys.lists(userId) }),
  ]).then(() => {
    queryClient.setQueryData<ThreadDetailData>(
      threadKeys.detail(userId, thread.id),
      (cached) => withSettledTitle(thread, cached),
    );
    const listItem = createdThreadListItem(thread, projectless);
    for (const query of queryClient.getQueryCache().findAll({
      queryKey: threadKeys.lists(userId),
    })) {
      if (!matchingActiveList(query.queryKey, thread.projectId)) continue;
      queryClient.setQueryData<ThreadListData>(query.queryKey, (current) => {
        if (current === undefined) return current;
        if (current.pages.length === 0) return current;
        const present = current.pages.some((page) =>
          page.items.some(({ id }) => id === thread.id),
        );
        return {
          ...current,
          pages: current.pages.map((page, index) =>
            page.items.some(({ id }) => id === thread.id)
              ? {
                  ...page,
                  items: page.items.map((item) =>
                    item.id === thread.id
                      ? withSettledTitle(listItem, item)
                      : item,
                  ),
                }
              : index === 0 && !present
                ? { ...page, items: [listItem, ...page.items] }
                : page,
          ),
        };
      });
    }
  });

export const createThreadMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
) =>
  mutationOptions({
    mutationKey: [...threadKeys.all(userId), "create"] as const,
    mutationFn: async (input: CreateThreadMutationInput) => {
      const response =
        "initialMessage" in input
          ? await createThread(
              input.project?.id,
              input.title,
              input.selection,
              input.runnerProfileId,
              input.initialMessage,
              input.threadId,
              input.signal,
              input.claudeConnectionId,
              input.visibility,
            )
          : await createThread(
              input.project?.id,
              input.title,
              input.selection,
              input.runnerProfileId,
              undefined,
              undefined,
              undefined,
              input.claudeConnectionId,
              input.visibility,
            );
      if ("initialMessage" in input && response.initialSubmission === undefined)
        throw new Error("The initial message receipt was missing.");
      return response;
    },
    onMutate: ({ project }) => {
      if (project !== undefined)
        seedProjectDetail(queryClient, userId, project);
    },
    onSuccess: (response, { project }) =>
      cacheCreatedThread(
        queryClient,
        userId,
        response.data,
        project === undefined,
      ),
  });

interface CreateBlankThreadMutationInput {
  readonly project?: ProjectData;
  readonly title: ThreadDetailData["title"];
  readonly selection?: ThreadModelSelection;
  readonly runnerProfileId?: RunnerProfileId;
  /** The Claude plan a Claude Code Thread is bound to for its life. */
  readonly claudeConnectionId?: string;
  /** `workspace` shares the Thread with the workspace as it is created. */
  readonly visibility?: ThreadVisibility;
}

interface CreateThreadWithInitialMessageMutationInput
  extends CreateBlankThreadMutationInput {
  readonly initialMessage: InitialThreadMessage;
  readonly threadId: ThreadId;
  /** Abandons this send; the server still finishes what it admitted. */
  readonly signal?: AbortSignal;
}

export type CreateThreadMutationInput =
  | CreateBlankThreadMutationInput
  | CreateThreadWithInitialMessageMutationInput;

export const setThreadPinnedMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
) =>
  mutationOptions({
    mutationKey: [...threadKeys.all(userId), "pin"] as const,
    mutationFn: ({
      threadId,
      pinned,
    }: {
      threadId: ThreadId;
      pinned: boolean;
    }) => setThreadPinned(threadId, pinned),
    // The sidebar moves the row at once and puts it back if the server
    // refuses, as it does for a snooze.
    onMutate: async ({ threadId, pinned }) => {
      await queryClient.cancelQueries({ queryKey: threadKeys.lists(userId) });
      const previousLists = queryClient.getQueriesData<ThreadListData>({
        queryKey: threadKeys.lists(userId),
      });
      const now = Date.now();
      queryClient.setQueriesData<ThreadListData>(
        { queryKey: threadKeys.lists(userId) },
        (current) =>
          current === undefined
            ? current
            : {
                ...current,
                pages: current.pages.map((page) =>
                  flatMapListedThreads(page, (thread) => {
                    if (thread.id !== threadId) return [thread];
                    const { pinnedAt: _pinnedAt, ...unpinned } = thread;
                    // Pinning wakes a snoozed Thread.
                    return [
                      pinned
                        ? {
                            ...withSnooze(thread, null, now),
                            pinnedAt: DateTime.makeUnsafe(now),
                          }
                        : unpinned,
                    ];
                  }),
                ),
              },
      );
      return { previousLists };
    },
    onSuccess: (thread: ThreadData) => {
      // Pinning wakes a snoozed Thread.
      queryClient.setQueryData<ThreadDetailData>(
        threadKeys.detail(userId, thread.id),
        (detail) => withThreadRow(detail, thread),
      );
      return queryClient.invalidateQueries({
        queryKey: threadKeys.lists(userId),
      });
    },
    onError: (_error, _variables, rollback) => {
      for (const [queryKey, data] of rollback?.previousLists ?? [])
        queryClient.setQueryData(queryKey, data);
      return queryClient.invalidateQueries({
        queryKey: threadKeys.lists(userId),
      });
    },
  });

/**
 * A Thread's detail with the server's row applied. The row has no snooze
 * once woken, so a snooze the detail still holds goes with it.
 */
const withThreadRow = (
  detail: ThreadDetailData | undefined,
  thread: ThreadData,
): ThreadDetailData | undefined => {
  if (detail === undefined) return detail;
  const { snoozedUntil: _until, snoozeWokeAt: _wokeAt, ...rest } = detail;
  return { ...rest, ...thread };
};

/** A snooze or wake as the server will apply it to a listed Thread. */
const withSnooze = <
  Cached extends Pick<ThreadData, "snoozedUntil" | "snoozeWokeAt">,
>(
  thread: Cached,
  snoozedUntil: Date | null,
  now: number,
): Cached => {
  const { snoozedUntil: previous, ...rest } = thread;
  if (snoozedUntil !== null)
    return {
      ...rest,
      snoozedUntil: DateTime.makeUnsafe(snoozedUntil),
    } as Cached;
  return (
    previous === undefined
      ? thread
      : {
          ...rest,
          snoozeWokeAt: DateTime.makeUnsafe(
            Math.min(DateTime.toEpochMillis(previous), now),
          ),
        }
  ) as Cached;
};

/**
 * Snoozes a Thread until a time, or wakes it with `null`. The sidebar moves
 * the row at once and puts it back if the server refuses.
 */
export const setThreadSnoozedMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
) => {
  const mutationKey = [...threadKeys.all(userId), "snooze"] as const;
  /**
   * True while a later snooze or wake for the Thread waits its turn: its
   * optimistic state is newer than this request's result or rollback.
   */
  const superseded = (threadId: ThreadId) =>
    queryClient.isMutating({
      mutationKey,
      predicate: (mutation) =>
        (mutation.state.variables as { threadId?: ThreadId } | undefined)
          ?.threadId === threadId,
    }) > 1;
  return mutationOptions({
    mutationKey,
    // Snoozes and wakes reach the server in the order they were chosen, so
    // Undo or Wake works while the snooze is still in flight.
    scope: { id: "thread-snooze" },
    mutationFn: ({
      threadId,
      snoozedUntil,
    }: {
      threadId: ThreadId;
      snoozedUntil: Date | null;
    }) => setThreadSnoozed(threadId, snoozedUntil),
    onMutate: async ({ threadId, snoozedUntil }) => {
      await Promise.all([
        queryClient.cancelQueries({
          queryKey: threadKeys.detail(userId, threadId),
          exact: true,
        }),
        queryClient.cancelQueries({ queryKey: threadKeys.lists(userId) }),
      ]);
      const previousDetail = queryClient.getQueryData<ThreadDetailData>(
        threadKeys.detail(userId, threadId),
      );
      const previousLists = queryClient.getQueriesData<ThreadListData>({
        queryKey: threadKeys.lists(userId),
      });
      const now = Date.now();
      queryClient.setQueryData<ThreadDetailData>(
        threadKeys.detail(userId, threadId),
        (detail) =>
          detail === undefined ? detail : withSnooze(detail, snoozedUntil, now),
      );
      queryClient.setQueriesData<ThreadListData>(
        { queryKey: threadKeys.lists(userId) },
        (current) =>
          current === undefined
            ? current
            : {
                ...current,
                pages: current.pages.map((page) =>
                  flatMapListedThreads(page, (thread) => [
                    thread.id === threadId
                      ? withSnooze(thread, snoozedUntil, now)
                      : thread,
                  ]),
                ),
              },
      );
      return { previousDetail, previousLists };
    },
    onSuccess: (thread: ThreadData) => {
      if (superseded(thread.id)) return;
      queryClient.setQueryData<ThreadDetailData>(
        threadKeys.detail(userId, thread.id),
        (detail) => withThreadRow(detail, thread),
      );
      return queryClient.invalidateQueries({
        queryKey: threadKeys.lists(userId),
      });
    },
    onError: (_error, { threadId }, rollback) => {
      if (superseded(threadId)) return;
      if (rollback !== undefined)
        queryClient.setQueryData(
          threadKeys.detail(userId, threadId),
          rollback.previousDetail,
        );
      for (const [queryKey, data] of rollback?.previousLists ?? [])
        queryClient.setQueryData(queryKey, data);
      // The rollback can hold an earlier request's optimistic state.
      return Promise.all([
        queryClient.invalidateQueries({
          queryKey: threadKeys.detail(userId, threadId),
          exact: true,
        }),
        queryClient.invalidateQueries({ queryKey: threadKeys.lists(userId) }),
      ]);
    },
  });
};

/**
 * Shows Threads archived or restored in the detail and list caches at once,
 * before the server answers, and returns what they held before.
 */
const showArchived = async (
  queryClient: QueryClient,
  userId: UserId,
  threadIds: ReadonlyArray<ThreadId>,
  archived: boolean,
) => {
  await Promise.all([
    ...threadIds.map((threadId) =>
      queryClient.cancelQueries({
        queryKey: threadKeys.detail(userId, threadId),
        exact: true,
      }),
    ),
    queryClient.cancelQueries({ queryKey: threadKeys.lists(userId) }),
  ]);
  const previousDetails = threadIds.map((threadId) =>
    queryClient.getQueryData<ThreadDetailData>(
      threadKeys.detail(userId, threadId),
    ),
  );
  const previousLists = queryClient.getQueriesData<ThreadListData>({
    queryKey: threadKeys.lists(userId),
  });
  const lifecycleState = archived ? "archived" : "active";
  for (const threadId of threadIds)
    queryClient.setQueryData<ThreadDetailData>(
      threadKeys.detail(userId, threadId),
      (detail) =>
        detail === undefined
          ? detail
          : {
              ...detail,
              lifecycleState,
              ...(archived ? { pinnedAt: undefined } : {}),
            },
    );
  const changing = new Set<ThreadId>(threadIds);
  // Each Thread's row as it will read, from whichever list holds it, so the
  // row joins its new section at once instead of after the refetch (#1771).
  const moved = new Map<ThreadId, ListedThread>();
  for (const [, data] of previousLists)
    for (const page of data?.pages ?? [])
      for (const thread of [...page.items, ...(page.children ?? [])])
        if (changing.has(thread.id) && !moved.has(thread.id))
          moved.set(thread.id, {
            ...thread,
            lifecycleState,
            ...(archived ? { pinnedAt: undefined } : {}),
          });
  // One render for every list: the row never shows in neither section.
  notifyManager.batch(() => {
    for (const query of queryClient.getQueryCache().findAll({
      queryKey: threadKeys.lists(userId),
    })) {
      queryClient.setQueryData<ThreadListData>(query.queryKey, (current) => {
        if (current === undefined) return current;
        const listed = new Set<ThreadId>();
        let next: ThreadListData = {
          ...current,
          pages: current.pages.map((page) =>
            flatMapListedThreads(page, (thread) => {
              if (!changing.has(thread.id)) return [thread];
              const scope = query.queryKey[3] as
                | { readonly lifecycleState?: string | null }
                | undefined;
              if (
                scope?.lifecycleState != null &&
                scope.lifecycleState !== lifecycleState
              )
                return [];
              listed.add(thread.id);
              return [
                {
                  ...thread,
                  lifecycleState,
                  ...(archived ? { pinnedAt: undefined } : {}),
                },
              ];
            }),
          ),
        };
        for (const row of moved.values())
          if (
            !listed.has(row.id) &&
            belongsInLoadedList(query.queryKey, next, row)
          )
            next = insertListed(next, row);
        return next;
      });
    }
  });
  return { previousDetails, previousLists };
};

type ListedThread = ThreadPage["items"][number];

/** Puts a row in its place by list order among the list's loaded items. */
const insertListed = (
  data: ThreadListData,
  row: ListedThread,
): ThreadListData => {
  const pages = [...data.pages];
  for (const [index, page] of pages.entries()) {
    const at = page.items.findIndex((other) => listOrder(row, other) < 0);
    if (at === -1) continue;
    pages[index] = {
      ...page,
      items: [...page.items.slice(0, at), row, ...page.items.slice(at)],
    };
    return { ...data, pages };
  }
  const last = pages.at(-1);
  if (last === undefined) return data;
  pages[pages.length - 1] = { ...last, items: [...last.items, row] };
  return { ...data, pages };
};

/**
 * The server's own reason an archive or restore failed, when it gave one;
 * a lost connection's browser text ("Failed to fetch") is not one (#1771).
 */
export const archiveFailureReason = (cause: unknown) =>
  cause instanceof ApiError && cause.message !== "" ? cause.message : undefined;

/** How many archive requests a bulk archive keeps in flight. */
const BULK_ARCHIVE_CONCURRENCY = 4;

/** A bulk archive's or restore's outcome, Thread by Thread. */
export interface ArchivedThreads {
  readonly changed: ReadonlyArray<ThreadId>;
  readonly failed: ReadonlyArray<ThreadId>;
}

/**
 * Archives or restores many Threads, such as every Inactive one. They
 * change on the page at once; the requests then run a few at a time, in
 * order with single archives, and the lists refetch once at the end, so a
 * Thread the server refused comes back.
 */
export const setThreadsArchivedMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
) =>
  mutationOptions({
    mutationKey: [...threadKeys.all(userId), "archive-many"] as const,
    scope: { id: "thread-archive" },
    mutationFn: async ({
      threadIds,
      archived,
    }: {
      threadIds: ReadonlyArray<ThreadId>;
      archived: boolean;
    }): Promise<ArchivedThreads> => {
      const changed: Array<ThreadId> = [];
      const failed: Array<ThreadId> = [];
      for (let at = 0; at < threadIds.length; at += BULK_ARCHIVE_CONCURRENCY) {
        const batch = threadIds.slice(at, at + BULK_ARCHIVE_CONCURRENCY);
        const results = await Promise.allSettled(
          batch.map((threadId) => setThreadArchived(threadId, archived)),
        );
        results.forEach((result, index) => {
          const threadId = batch[index];
          if (threadId === undefined) return;
          (result.status === "fulfilled" ? changed : failed).push(threadId);
        });
      }
      return { changed, failed };
    },
    onMutate: ({ threadIds, archived }) =>
      showArchived(queryClient, userId, threadIds, archived),
    onSettled: (_result, _error, { threadIds }) =>
      Promise.all([
        ...threadIds.map((threadId) =>
          queryClient.invalidateQueries({
            queryKey: threadKeys.detail(userId, threadId),
            exact: true,
          }),
        ),
        queryClient.invalidateQueries({ queryKey: threadKeys.lists(userId) }),
      ]),
  });

export const setThreadArchivedMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
) => {
  const mutationKey = [...threadKeys.all(userId), "archive"] as const;
  /**
   * True while a later archive or unarchive of the Thread waits its turn:
   * its optimistic state is newer than this request's result or rollback.
   */
  const superseded = (threadId: ThreadId) =>
    queryClient.isMutating({
      mutationKey,
      predicate: (mutation) =>
        (mutation.state.variables as { threadId?: ThreadId } | undefined)
          ?.threadId === threadId,
    }) > 1;
  return mutationOptions({
    mutationKey,
    // Archives and unarchives reach the server in the order they were
    // chosen, so Undo works while the archive is still in flight.
    scope: { id: "thread-archive" },
    mutationFn: async ({
      threadId,
      archived,
      children,
      reason,
    }: {
      threadId: ThreadId;
      archived: boolean;
      /** `ship`: archived from its Ship outcome; its work shipped. */
      reason?: "ship";
      /**
       * True for every child, or the exact children to change. An Undo
       * chosen before its archive returned passes the archive's answer,
       * which has settled by the time this request runs.
       */
      children?:
        | true
        | ReadonlyArray<ThreadId>
        | Promise<ReadonlyArray<ThreadId> | undefined>;
    }) => setThreadArchived(threadId, archived, await children, reason),
    onMutate: async ({ threadId, archived }) => {
      const { previousDetails, previousLists } = await showArchived(
        queryClient,
        userId,
        [threadId],
        archived,
      );
      return { previousDetail: previousDetails[0], previousLists };
    },
    onSuccess: ({ thread }: ArchivedThread) => {
      if (superseded(thread.id)) return;
      queryClient.setQueryData<ThreadDetailData>(
        threadKeys.detail(userId, thread.id),
        (detail) => (detail === undefined ? detail : { ...detail, ...thread }),
      );
      return queryClient.invalidateQueries({
        queryKey: threadKeys.lists(userId),
      });
    },
    onError: (_error, { threadId }, rollback) => {
      if (superseded(threadId)) return;
      if (rollback !== undefined) {
        queryClient.setQueryData(
          threadKeys.detail(userId, threadId),
          rollback.previousDetail,
        );
        for (const [queryKey, data] of rollback.previousLists) {
          queryClient.setQueryData(queryKey, data);
        }
      }
      return Promise.all([
        queryClient.invalidateQueries({
          queryKey: threadKeys.detail(userId, threadId),
          exact: true,
        }),
        queryClient.invalidateQueries({
          queryKey: threadKeys.lists(userId),
        }),
      ]);
    },
  });
};

/**
 * Deletes a Thread, and with `includeChildren` the children listed under
 * it, once the server confirms: they leave every list and their details are
 * dropped. Lists refetch, since children left behind become top-level.
 */
export const deleteThreadMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
) =>
  mutationOptions({
    mutationKey: [...threadKeys.all(userId), "delete"] as const,
    mutationFn: ({
      threadId,
      includeChildren = false,
    }: {
      threadId: ThreadId;
      includeChildren?: boolean;
    }) => deleteThread(threadId, includeChildren),
    onSuccess: ({ deletedChildThreadIds = [] }, { threadId }) => {
      const deleted = new Set<ThreadId>([threadId, ...deletedChildThreadIds]);
      for (const query of queryClient.getQueryCache().findAll({
        queryKey: threadKeys.lists(userId),
      }))
        queryClient.setQueryData<ThreadListData>(query.queryKey, (current) =>
          current === undefined
            ? current
            : {
                ...current,
                pages: current.pages.map((page) =>
                  flatMapListedThreads(page, (thread) =>
                    deleted.has(thread.id) ? [] : [thread],
                  ),
                ),
              },
        );
      for (const id of deleted)
        queryClient.removeQueries({
          queryKey: threadKeys.detail(userId, id),
          exact: true,
        });
      return queryClient.invalidateQueries({
        queryKey: threadKeys.lists(userId),
      });
    },
  });

/** A rename or recolor as the server will apply it. */
const withThreadUpdate = <Cached extends ThreadData>(
  thread: Cached,
  update: UpdateThreadRequest,
): Cached => {
  const { titlePending: _pending, color: _color, ...rest } = thread;
  const title = update.title ?? thread.title;
  const titlePending =
    update.title === undefined ? thread.titlePending : undefined;
  const color = update.color === undefined ? thread.color : update.color;
  return {
    ...rest,
    title,
    ...(titlePending === undefined ? {} : { titlePending }),
    ...(color === null || color === undefined ? {} : { color }),
  } as Cached;
};

export const updateThreadMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
) =>
  mutationOptions({
    mutationKey: [...threadKeys.all(userId), "update"] as const,
    mutationFn: ({
      threadId,
      update,
    }: {
      threadId: ThreadId;
      update: UpdateThreadRequest;
    }) => updateThread(threadId, update),
    onMutate: async ({ threadId, update }) => {
      await Promise.all([
        queryClient.cancelQueries({
          queryKey: threadKeys.detail(userId, threadId),
          exact: true,
        }),
        queryClient.cancelQueries({ queryKey: threadKeys.lists(userId) }),
      ]);
      const previousDetail = queryClient.getQueryData<ThreadDetailData>(
        threadKeys.detail(userId, threadId),
      );
      const previousLists = queryClient.getQueriesData<ThreadListData>({
        queryKey: threadKeys.lists(userId),
      });
      queryClient.setQueryData<ThreadDetailData>(
        threadKeys.detail(userId, threadId),
        (detail) =>
          detail === undefined ? detail : withThreadUpdate(detail, update),
      );
      queryClient.setQueriesData<ThreadListData>(
        { queryKey: threadKeys.lists(userId) },
        (current) =>
          current === undefined
            ? current
            : {
                ...current,
                pages: current.pages.map((page) =>
                  flatMapListedThreads(page, (thread) => [
                    thread.id === threadId
                      ? withThreadUpdate(thread, update)
                      : thread,
                  ]),
                ),
              },
      );
      return { previousDetail, previousLists };
    },
    onSuccess: (thread: ThreadData) => {
      queryClient.setQueryData<ThreadDetailData>(
        threadKeys.detail(userId, thread.id),
        (detail) => {
          if (detail === undefined) return detail;
          // Optional fields the server omitted are cleared, not kept.
          const { color: _color, titlePending: _pending, ...rest } = detail;
          return { ...rest, ...thread };
        },
      );
      return queryClient.invalidateQueries({
        queryKey: threadKeys.lists(userId),
      });
    },
    onError: (_error, { threadId }, rollback) => {
      if (rollback !== undefined) {
        queryClient.setQueryData(
          threadKeys.detail(userId, threadId),
          rollback.previousDetail,
        );
        for (const [queryKey, data] of rollback.previousLists) {
          queryClient.setQueryData(queryKey, data);
        }
      }
      // The snapshot may predate an overlapping update that succeeded, so
      // the server, not the rollback, decides what the Thread shows.
      return Promise.all([
        queryClient.invalidateQueries({
          queryKey: threadKeys.detail(userId, threadId),
          exact: true,
        }),
        queryClient.invalidateQueries({
          queryKey: threadKeys.lists(userId),
        }),
      ]);
    },
  });

/**
 * Retry on a new Thread whose first message failed to start: the agent gets
 * the same stored message, and the Thread's detail is read again so its
 * page follows the message.
 */
export const retryInitialThreadDispatch = async (
  queryClient: QueryClient,
  userId: UserId,
  threadId: ThreadId,
) => {
  await retryInitialDispatch(threadId);
  await invalidateThreadQueries(queryClient, userId, threadId);
};
