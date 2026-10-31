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
  UserId,
} from "@dx/domain";
import {
  type InfiniteData,
  mutationOptions,
  type QueryClient,
} from "@tanstack/react-query";
import { DateTime } from "effect";
import {
  type ArchivedThread,
  deleteThread,
  request,
  setThreadArchived,
  setThreadPinned,
  setThreadSnoozed,
  type ThreadPage,
  updateThread,
} from "../../shared/api/client.js";
import { seedProjectDetail } from "../projects/project-mutations.js";
import { threadKeys } from "./thread-queries.js";

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
            )
          : await createThread(
              input.project?.id,
              input.title,
              input.selection,
              input.runnerProfileId,
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
) =>
  mutationOptions({
    mutationKey: [...threadKeys.all(userId), "snooze"] as const,
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
      queryClient.setQueryData<ThreadDetailData>(
        threadKeys.detail(userId, thread.id),
        (detail) => withThreadRow(detail, thread),
      );
      return queryClient.invalidateQueries({
        queryKey: threadKeys.lists(userId),
      });
    },
    onError: (_error, { threadId }, rollback) => {
      if (rollback !== undefined)
        queryClient.setQueryData(
          threadKeys.detail(userId, threadId),
          rollback.previousDetail,
        );
      for (const [queryKey, data] of rollback?.previousLists ?? [])
        queryClient.setQueryData(queryKey, data);
      return queryClient.invalidateQueries({
        queryKey: threadKeys.lists(userId),
      });
    },
  });

export const setThreadArchivedMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
) =>
  mutationOptions({
    mutationKey: [...threadKeys.all(userId), "archive"] as const,
    mutationFn: ({
      threadId,
      archived,
      children,
    }: {
      threadId: ThreadId;
      archived: boolean;
      /** True for every child, or the exact children to change. */
      children?: true | ReadonlyArray<ThreadId>;
    }) => setThreadArchived(threadId, archived, children),
    onMutate: async ({ threadId, archived }) => {
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
      const lifecycleState = archived ? "archived" : "active";
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
      for (const query of queryClient.getQueryCache().findAll({
        queryKey: threadKeys.lists(userId),
      })) {
        queryClient.setQueryData<ThreadListData>(query.queryKey, (current) =>
          current === undefined
            ? current
            : {
                ...current,
                pages: current.pages.map((page) =>
                  flatMapListedThreads(page, (thread) => {
                    if (thread.id !== threadId) return [thread];
                    const scope = query.queryKey[3] as
                      | { readonly lifecycleState?: string | null }
                      | undefined;
                    if (
                      scope?.lifecycleState != null &&
                      scope.lifecycleState !== lifecycleState
                    )
                      return [];
                    return [
                      {
                        ...thread,
                        lifecycleState,
                        ...(archived ? { pinnedAt: undefined } : {}),
                      },
                    ];
                  }),
                ),
              },
        );
      }
      return { previousDetail, previousLists };
    },
    onSuccess: ({ thread }: ArchivedThread) => {
      queryClient.setQueryData<ThreadDetailData>(
        threadKeys.detail(userId, thread.id),
        (detail) => (detail === undefined ? detail : { ...detail, ...thread }),
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
