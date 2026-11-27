import type {
  InitialThreadMessage,
  ProjectData,
  SpaceData,
  ThreadData,
  ThreadDetailData,
  ThreadListItem,
  UpdateThreadRequest,
} from "@dx/api";
import {
  ArchiveThreadEndpoint,
  CreateThreadEndpoint,
  DeleteThreadEndpoint,
  PinThreadEndpoint,
  RetryInitialDispatchEndpoint,
  SnoozeThreadEndpoint,
  StartMailThreadEndpoint,
  threadAgentUrl,
  UpdateThreadEndpoint,
} from "@dx/api";
import type {
  ModelConnectionId,
  ProjectId,
  RunnerProfileId,
  ThreadId,
  ThreadModelSelection,
  ThreadTitle,
  ThreadVisibility,
  UserId,
} from "@dx/domain";
import {
  hashKey,
  type InfiniteData,
  mutationOptions,
  notifyManager,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { DateTime } from "effect";
import { ApiError, dxClient } from "../../shared/api/client.js";
import { seedProjectDetail } from "../projects/project-cache-mutations.js";
import {
  invalidateSpaceForThread,
  spaceKeys,
} from "../spaces/space-cache-queries.js";
import { belongsInLoadedList, listOrder } from "./thread-list-order-queries.js";
import {
  invalidateThreadQueries,
  type ThreadPage,
  threadKeys,
} from "./thread-queries.js";
import {
  requestedChanges,
  withChanges,
} from "./thread-requested-change-queries.js";

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
  pluginAgentMode?: string,
  pluginThreadType?: string,
  fromMailId?: string,
  runnerMachineId?: string,
): Promise<typeof CreateThreadEndpoint.success.Type> => {
  const body = {
    ...(projectId === undefined ? {} : { projectId }),
    title,
    ...(selection === undefined ? {} : { selection }),
    ...(runnerProfileId === undefined ? {} : { runnerProfileId }),
    ...(runnerMachineId === undefined ? {} : { runnerMachineId }),
    ...(initialMessage === undefined ? {} : { initialMessage }),
    ...(threadId === undefined ? {} : { threadId }),
    ...(claudeConnectionId === undefined
      ? {}
      : { claudeConnectionId: claudeConnectionId as ModelConnectionId }),
    ...(visibility === undefined ? {} : { visibility }),
    ...(pluginAgentMode === undefined ? {} : { pluginAgentMode }),
    ...(pluginThreadType === undefined ? {} : { pluginThreadType }),
  };
  // Start thread on an email sends the same request to Mail, which puts
  // the email in the first message and answers as `/v1/threads` does.
  return fromMailId === undefined
    ? dxClient.call(CreateThreadEndpoint, { body }, { signal })
    : dxClient.call(
        StartMailThreadEndpoint,
        { params: { id: fromMailId }, body },
        { signal },
      );
};

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

const createdHere = new Set<string>();

/** This client created the Thread, so opening it has nothing to mark seen. */
export const wasCreatedHere = (threadId: ThreadId) => createdHere.has(threadId);

export const cacheCreatedThread = (
  queryClient: QueryClient,
  userId: UserId,
  thread: ThreadDetailData,
  /** Created in No Project, which the detail does not say. */
  projectless = false,
) => {
  createdHere.add(thread.id);
  return Promise.all([
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
};

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
              input.pluginAgentMode,
              input.pluginThreadType,
              input.fromMailId,
              input.runnerMachineId,
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
              undefined,
              undefined,
              undefined,
              input.runnerMachineId,
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
  /** The person's machine a runner Thread runs on. */
  readonly runnerMachineId?: string;
  /** The Claude plan a Claude Code Thread is bound to for its life. */
  readonly claudeConnectionId?: string;
  /** `workspace` shares the Thread with the workspace as it is created. */
  readonly visibility?: ThreadVisibility;
}

interface CreateThreadWithInitialMessageMutationInput
  extends CreateBlankThreadMutationInput {
  readonly initialMessage: InitialThreadMessage;
  readonly threadId: ThreadId;
  /** An installed plugin's agent mode: the Thread runs as its agent. */
  readonly pluginAgentMode?: string;
  /** An installed plugin's Thread type, `<plugin>/<type>`. */
  readonly pluginThreadType?: string;
  /** The email in the person's Mail the Thread starts from. */
  readonly fromMailId?: string;
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
      const apply = <Thread extends ThreadData>(thread: Thread): Thread => {
        const { pinnedAt: _pinnedAt, ...unpinned } = thread;
        // Pinning wakes a snoozed Thread.
        return pinned
          ? {
              ...withSnooze(thread, null, now),
              pinnedAt: DateTime.makeUnsafe(now),
            }
          : (unpinned as Thread);
      };
      const change = requestedChanges(queryClient).request({
        threadId,
        apply,
      });
      queryClient.setQueriesData<ThreadListData>(
        { queryKey: threadKeys.lists(userId) },
        (current) =>
          current === undefined
            ? current
            : {
                ...current,
                pages: current.pages.map((page) =>
                  flatMapListedThreads(page, (thread) => [
                    thread.id === threadId ? apply(thread) : thread,
                  ]),
                ),
              },
      );
      return { previousLists, change };
    },
    onSuccess: (thread: ThreadData, _variables, context) => {
      requestedChanges(queryClient).settle(context.change);
      const pending = requestedChanges(queryClient).pending(thread.id);
      // Pinning wakes a snoozed Thread.
      queryClient.setQueryData<ThreadDetailData>(
        threadKeys.detail(userId, thread.id),
        (detail) => {
          const next = withThreadRow(detail, thread);
          return next === undefined ? next : withChanges(next, pending);
        },
      );
      return queryClient.invalidateQueries({
        queryKey: threadKeys.lists(userId),
      });
    },
    onError: (_error, { threadId }, context) => {
      requestedChanges(queryClient).drop(context?.change);
      if (context !== undefined)
        restoreThread(queryClient, userId, threadId, context.previousLists);
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
      const apply = <Thread extends ThreadData>(thread: Thread): Thread =>
        withSnooze(thread, snoozedUntil, now);
      const change = requestedChanges(queryClient).request({
        threadId,
        apply,
      });
      queryClient.setQueryData<ThreadDetailData>(
        threadKeys.detail(userId, threadId),
        (detail) => (detail === undefined ? detail : apply(detail)),
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
                    thread.id === threadId ? apply(thread) : thread,
                  ]),
                ),
              },
      );
      return { previousDetail, previousLists, change };
    },
    onSuccess: (thread: ThreadData, _variables, context) => {
      requestedChanges(queryClient).settle(context.change);
      if (superseded(thread.id)) return;
      const pending = requestedChanges(queryClient).pending(thread.id);
      queryClient.setQueryData<ThreadDetailData>(
        threadKeys.detail(userId, thread.id),
        (detail) => {
          const next = withThreadRow(detail, thread);
          return next === undefined ? next : withChanges(next, pending);
        },
      );
      return queryClient.invalidateQueries({
        queryKey: threadKeys.lists(userId),
      });
    },
    onError: (_error, { threadId }, context) => {
      requestedChanges(queryClient).drop(context?.change);
      if (superseded(threadId)) return;
      if (context !== undefined)
        restoreThread(
          queryClient,
          userId,
          threadId,
          context.previousLists,
          context.previousDetail,
        );
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

/** A Thread archived or restored, as the server will apply it. */
const archivedAs =
  (archived: boolean) =>
  <Thread extends ThreadData>(thread: Thread): Thread => ({
    ...thread,
    lifecycleState: archived ? "archived" : "active",
    ...(archived ? { pinnedAt: undefined } : {}),
  });

/**
 * Shows Threads archived or restored in the detail and list caches at once,
 * before the server answers, and returns what they held before with the
 * change each one requested.
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
    queryClient.cancelQueries({
      queryKey: spaceKeys.joined(userId),
      exact: true,
    }),
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
  const apply = archivedAs(archived);
  for (const threadId of threadIds)
    queryClient.setQueryData<ThreadDetailData>(
      threadKeys.detail(userId, threadId),
      (detail) => (detail === undefined ? detail : apply(detail)),
    );
  const changing = new Set<ThreadId>(threadIds);
  // Each Thread's row as it will read, from whichever list holds it, so the
  // row joins its new section at once instead of after the refetch (#1771).
  const moved = new Map<ThreadId, ListedThread>();
  for (const [, data] of previousLists)
    for (const page of data?.pages ?? [])
      for (const thread of [...page.items, ...(page.children ?? [])])
        if (changing.has(thread.id) && !moved.has(thread.id))
          moved.set(thread.id, apply(thread));
  // Until the server answers, reads that predate the change show it too.
  const ledger = requestedChanges(queryClient);
  // An Undo while no loaded list holds the Thread puts back its last row.
  for (const threadId of threadIds) {
    const row = moved.has(threadId) ? undefined : ledger.row(threadId);
    if (row !== undefined) moved.set(threadId, apply(row));
  }
  const changes = new Map(
    threadIds.map((threadId) => {
      const row = moved.get(threadId);
      return [
        threadId,
        ledger.request({
          threadId,
          lifecycleState,
          apply,
          ...(row === undefined ? {} : { row }),
        }),
      ] as const;
    }),
  );
  // One render for every list: the row never shows in neither section.
  notifyManager.batch(() => {
    // A Space leaves the Spaces section at once, or returns to it.
    for (const threadId of threadIds) {
      const space = queryClient.getQueryData<SpaceData>(
        spaceKeys.detail(userId, threadId),
      );
      if (space !== undefined)
        queryClient.setQueryData<SpaceData>(
          spaceKeys.detail(userId, threadId),
          { ...space, lifecycleState },
        );
      queryClient.setQueryData<ReadonlyArray<SpaceData>>(
        spaceKeys.joined(userId),
        (spaces) =>
          spaces === undefined
            ? spaces
            : archived
              ? spaces.filter((joined) => joined.threadId !== threadId)
              : space === undefined
                ? spaces
                : // First until the answer's refetch puts it in order.
                  [
                    { ...space, lifecycleState },
                    ...spaces.filter((joined) => joined.threadId !== threadId),
                  ],
      );
    }
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
              return [apply(thread)];
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
  return { previousDetails, previousLists, changes };
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
 * Puts one Thread back as the cache held it before a change the server
 * refused, with the changes still in flight for it applied. Every other row
 * stays as it is: restoring whole lists would also undo the archives, pins,
 * and renames requested since the snapshot.
 */
const restoreThread = (
  queryClient: QueryClient,
  userId: UserId,
  threadId: ThreadId,
  previousLists: ReadonlyArray<readonly [QueryKey, ThreadListData | undefined]>,
  previousDetail?: ThreadDetailData,
) => {
  const pending = requestedChanges(queryClient).pending(threadId);
  if (previousDetail !== undefined)
    queryClient.setQueryData(
      threadKeys.detail(userId, threadId),
      withChanges(previousDetail, pending),
    );
  const before = new Map(
    previousLists.map(([queryKey, data]) => [hashKey(queryKey), data]),
  );
  notifyManager.batch(() => {
    for (const query of queryClient.getQueryCache().findAll({
      queryKey: threadKeys.lists(userId),
    })) {
      if (!before.has(query.queryHash)) continue;
      const previous = before.get(query.queryHash);
      const listLifecycle = (
        query.queryKey[3] as { readonly lifecycleState?: string | null }
      )?.lifecycleState;
      queryClient.setQueryData<ThreadListData>(query.queryKey, (current) => {
        if (current === undefined) return current;
        let next: ThreadListData = {
          ...current,
          pages: current.pages.map((page) =>
            flatMapListedThreads(page, (thread) =>
              thread.id === threadId ? [] : [thread],
            ),
          ),
        };
        for (const [index, page] of (previous?.pages ?? []).entries()) {
          const asRoot = page.items.find(({ id }) => id === threadId);
          const asChild = page.children?.find(({ id }) => id === threadId);
          const row = asRoot ?? asChild;
          if (row === undefined) continue;
          const restored = withChanges(row, pending);
          if (
            listLifecycle != null &&
            listLifecycle !== restored.lifecycleState
          )
            break;
          if (asRoot !== undefined) next = insertListed(next, restored);
          else
            next = {
              ...next,
              pages: next.pages.map((nextPage, at) =>
                at === index
                  ? {
                      ...nextPage,
                      children: [...(nextPage.children ?? []), restored],
                    }
                  : nextPage,
              ),
            };
          break;
        }
        return next;
      });
    }
  });
};

/**
 * Each Thread's archive and restore requests, chained in the order they
 * were chosen, so Undo works while the archive is still in flight. Other
 * Threads' requests run alongside: archiving five Threads in a row must not
 * wait for each Orb to stop before the next request leaves (a reload in
 * that wait would lose the archives not yet sent).
 */
const threadRequests = new WeakMap<
  QueryClient,
  Map<ThreadId, Promise<unknown>>
>();

const inThreadOrder = <Result>(
  queryClient: QueryClient,
  threadId: ThreadId,
  run: () => Promise<Result>,
): Promise<Result> => {
  let chains = threadRequests.get(queryClient);
  if (chains === undefined) {
    chains = new Map();
    threadRequests.set(queryClient, chains);
  }
  const previous = chains.get(threadId) ?? Promise.resolve();
  const result = previous.then(run, run);
  const tail = result.catch(() => undefined);
  chains.set(threadId, tail);
  void tail.then(() => {
    if (chains.get(threadId) === tail) chains.delete(threadId);
  });
  return result;
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
 * change on the page at once; the requests then run a few at a time, each
 * in order with that Thread's single archives. A Thread the server refused
 * comes back, and the lists refetch once at the end.
 */
export const setThreadsArchivedMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
) =>
  mutationOptions({
    mutationKey: [...threadKeys.all(userId), "archive-many"] as const,
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
          batch.map((threadId) =>
            inThreadOrder(queryClient, threadId, () =>
              setThreadArchived(threadId, archived),
            ),
          ),
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
    onSuccess: ({ changed, failed }, _variables, context) => {
      const ledger = requestedChanges(queryClient);
      for (const threadId of changed)
        ledger.settle(context.changes.get(threadId));
      for (const threadId of failed) {
        ledger.drop(context.changes.get(threadId));
        restoreThread(queryClient, userId, threadId, context.previousLists);
      }
    },
    onError: (_error, { threadIds }, context) => {
      if (context === undefined) return;
      for (const threadId of threadIds) {
        requestedChanges(queryClient).drop(context.changes.get(threadId));
        restoreThread(queryClient, userId, threadId, context.previousLists);
      }
    },
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
    mutationFn: ({
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
    }) =>
      inThreadOrder(queryClient, threadId, async () =>
        setThreadArchived(threadId, archived, await children, reason),
      ),
    onMutate: async ({ threadId, archived }) => {
      const { previousDetails, previousLists, changes } = await showArchived(
        queryClient,
        userId,
        [threadId],
        archived,
      );
      return {
        previousDetail: previousDetails[0],
        previousLists,
        change: changes.get(threadId),
      };
    },
    onSuccess: ({ thread }: ArchivedThread, _variables, context) => {
      requestedChanges(queryClient).settle(context.change);
      if (superseded(thread.id)) return;
      const pending = requestedChanges(queryClient).pending(thread.id);
      queryClient.setQueryData<ThreadDetailData>(
        threadKeys.detail(userId, thread.id),
        (detail) =>
          detail === undefined
            ? detail
            : withChanges({ ...detail, ...thread }, pending),
      );
      return Promise.all([
        queryClient.invalidateQueries({
          queryKey: threadKeys.lists(userId),
        }),
        invalidateSpaceForThread(queryClient, userId, thread.id),
      ]);
    },
    onError: (_error, { threadId }, context) => {
      requestedChanges(queryClient).drop(context?.change);
      if (superseded(threadId)) return;
      if (context !== undefined)
        restoreThread(
          queryClient,
          userId,
          threadId,
          context.previousLists,
          context.previousDetail,
        );
      return Promise.all([
        queryClient.invalidateQueries({
          queryKey: threadKeys.detail(userId, threadId),
          exact: true,
        }),
        queryClient.invalidateQueries({
          queryKey: threadKeys.lists(userId),
        }),
        invalidateSpaceForThread(queryClient, userId, threadId),
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
  // A model change shows at once in the Thread's detail; lists hold none.
  const agentInitialization =
    update.selection !== undefined && "agentInitialization" in thread
      ? {
          agentInitialization: {
            ...(thread.agentInitialization as ThreadDetailData["agentInitialization"]),
            selection: update.selection,
          },
        }
      : {};
  return {
    ...rest,
    ...agentInitialization,
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
      const change = requestedChanges(queryClient).request({
        threadId,
        apply: (thread) => withThreadUpdate(thread, update),
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
      return { previousDetail, previousLists, change };
    },
    onSuccess: (thread: ThreadData, _variables, context) => {
      requestedChanges(queryClient).settle(context.change);
      const pending = requestedChanges(queryClient).pending(thread.id);
      queryClient.setQueryData<ThreadDetailData>(
        threadKeys.detail(userId, thread.id),
        (detail) => {
          if (detail === undefined) return detail;
          // Optional fields the server omitted are cleared, not kept.
          const { color: _color, titlePending: _pending, ...rest } = detail;
          return withChanges({ ...rest, ...thread }, pending);
        },
      );
      return queryClient.invalidateQueries({
        queryKey: threadKeys.lists(userId),
      });
    },
    onError: (_error, { threadId }, context) => {
      requestedChanges(queryClient).drop(context?.change);
      if (context !== undefined)
        restoreThread(
          queryClient,
          userId,
          threadId,
          context.previousLists,
          context.previousDetail,
        );
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

const setThreadPinned = async (
  threadId: ThreadId,
  pinned: boolean,
): Promise<ThreadData> =>
  (
    await dxClient.call(PinThreadEndpoint, {
      params: { threadId },
      body: { pinned },
    })
  ).data;

/** Hands a new Thread's first message that failed to start to its agent again. */
const retryInitialDispatch = async (threadId: ThreadId) =>
  (await dxClient.call(RetryInitialDispatchEndpoint, { params: { threadId } }))
    .data;

/** Snoozes the Thread until `snoozedUntil`, or wakes it when null. */
const setThreadSnoozed = async (
  threadId: ThreadId,
  snoozedUntil: Date | null,
): Promise<ThreadData> =>
  (
    await dxClient.call(SnoozeThreadEndpoint, {
      params: { threadId },
      body: {
        snoozedUntil:
          snoozedUntil === null ? null : DateTime.fromDateUnsafe(snoozedUntil),
      },
    })
  ).data;

const updateThread = async (
  threadId: ThreadId,
  update: UpdateThreadRequest,
): Promise<ThreadData> =>
  (
    await dxClient.call(UpdateThreadEndpoint, {
      params: { threadId },
      body: update,
    })
  ).data;

/** An archive or restore, and the child Threads it changed with it. */
export interface ArchivedThread {
  readonly thread: ThreadData;
  readonly changedChildThreadIds?: ReadonlyArray<ThreadId>;
  /** Archived, but its Orb couldn't be stopped yet; the server finishes it. */
  readonly orbStopping?: true;
}

/**
 * `children`: true for every child in the parent's former state, or the
 * exact children to change, as an Undo restores them. `reason: "ship"`
 * archives it from its Ship outcome, so its work counts as shipped.
 */
const setThreadArchived = async (
  threadId: ThreadId,
  archived: boolean,
  children?: true | ReadonlyArray<ThreadId>,
  reason?: "ship",
): Promise<ArchivedThread> => {
  const response = await dxClient.call(ArchiveThreadEndpoint, {
    params: { threadId },
    body: {
      archived,
      ...(children === undefined
        ? {}
        : {
            includeChildren: true,
            ...(children === true ? {} : { childThreadIds: children }),
          }),
      ...(reason === undefined ? {} : { reason }),
    },
  });
  return {
    thread: response.data,
    ...(response.changedChildThreadIds === undefined
      ? {}
      : { changedChildThreadIds: response.changedChildThreadIds }),
    ...(response.orbStopping === true ? { orbStopping: true as const } : {}),
  };
};

/**
 * Deletes a Thread for good: its conversation, sandbox, and files. `pending`
 * cleanup finishes on the server.
 */
const deleteThread = async (threadId: ThreadId, includeChildren = false) =>
  (
    await dxClient.call(DeleteThreadEndpoint, {
      params: { threadId },
      query: includeChildren ? { includeChildren: "true" } : {},
    })
  ).data;
