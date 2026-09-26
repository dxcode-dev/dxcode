import type {
  InitialThreadMessage,
  ProjectData,
  ThreadData,
  ThreadDetailData,
  ThreadListItem,
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
  request,
  setThreadArchived,
  setThreadPinned,
  type ThreadPage,
} from "../../shared/api/client.js";
import { seedProjectDetail } from "../projects/project-mutations.js";
import { threadKeys } from "./thread-queries.js";

type ThreadListData = InfiniteData<ThreadPage, unknown>;
const optimisticCreation = "__dxOptimisticCreation" as const;

export const createThread = async (
  projectId: ProjectId | undefined,
  title: ThreadTitle,
  selection?: ThreadModelSelection,
  runnerProfileId?: RunnerProfileId,
  initialMessage?: InitialThreadMessage,
  threadId?: ThreadId,
): Promise<typeof CreateThreadResponseSchema.Type> =>
  request("/v1/threads", CreateThreadResponseSchema, {
    method: "POST",
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
  readonly [optimisticCreation]: string;
};

export const isOptimisticThread = (
  thread: ThreadData,
): thread is OptimisticThreadData => optimisticCreation in thread;

export const optimisticThreadData = (
  id: ThreadId,
  projectId: ProjectId,
  title: ThreadTitle,
): OptimisticThreadData => {
  const now = DateTime.nowUnsafe();
  return {
    id,
    projectId,
    title,
    visibility: "private",
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
    activityStatus: "idle",
    lifecycleState: "active",
    agentUrl: threadAgentUrl(id),
    [optimisticCreation]: crypto.randomUUID(),
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
      }
    | undefined;
  return (
    scope?.lifecycleState !== "archived" &&
    (scope?.projectId === null || scope?.projectId === projectId)
  );
};

const updateLoadedThreadLists = (
  queryClient: QueryClient,
  userId: UserId,
  projectId: ProjectId,
  update: (items: ReadonlyArray<ThreadData>) => ReadonlyArray<ThreadData>,
) => {
  for (const query of queryClient.getQueryCache().findAll({
    queryKey: threadKeys.lists(userId),
  })) {
    if (!matchingActiveList(query.queryKey, projectId)) continue;
    queryClient.setQueryData<ThreadListData>(query.queryKey, (current) => {
      if (current === undefined || current.pages.length === 0) return current;
      return {
        ...current,
        pages: current.pages.map((page, index) =>
          index === 0 ? { ...page, items: update(page.items) } : page,
        ),
      };
    });
  }
};

export const cacheOptimisticThread = (
  queryClient: QueryClient,
  userId: UserId,
  thread: OptimisticThreadData,
) => {
  const cancellations = queryClient.cancelQueries({
    queryKey: threadKeys.lists(userId),
  });
  updateLoadedThreadLists(queryClient, userId, thread.projectId, (items) =>
    items.some(({ id }) => id === thread.id) ? items : [thread, ...items],
  );
  return cancellations;
};

export const rollbackOptimisticThread = (
  queryClient: QueryClient,
  userId: UserId,
  thread: OptimisticThreadData,
) => {
  updateLoadedThreadLists(queryClient, userId, thread.projectId, (items) =>
    items.filter(
      (item) =>
        !(
          item.id === thread.id &&
          (item as Partial<OptimisticThreadData>)[optimisticCreation] ===
            thread[optimisticCreation]
        ),
    ),
  );
};

const createdThreadListItem = (thread: ThreadDetailData): ThreadListItem => ({
  ...thread,
  mode:
    thread.agentInitialization.selection.kind === "mode"
      ? thread.agentInitialization.selection.mode
      : thread.agentInitialization.selection.model,
});

export const cacheCreatedThread = (
  queryClient: QueryClient,
  userId: UserId,
  thread: ThreadDetailData,
) =>
  Promise.all([
    queryClient.cancelQueries({
      queryKey: threadKeys.detail(userId, thread.id),
      exact: true,
    }),
    queryClient.cancelQueries({ queryKey: threadKeys.lists(userId) }),
  ]).then(() => {
    queryClient.setQueryData(threadKeys.detail(userId, thread.id), thread);
    const listItem = createdThreadListItem(thread);
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
                    item.id === thread.id ? listItem : item,
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
    onMutate: ({ project, ...input }) => {
      if (project !== undefined)
        seedProjectDetail(queryClient, userId, project);
      return "optimisticThread" in input && input.optimisticThread !== undefined
        ? cacheOptimisticThread(
            queryClient,
            userId,
            input.optimisticThread,
          ).then(() => ({ optimisticThread: input.optimisticThread }))
        : undefined;
    },
    onSuccess: (response) =>
      cacheCreatedThread(queryClient, userId, response.data),
    onError: (_error, _input, context) => {
      if (context?.optimisticThread !== undefined)
        rollbackOptimisticThread(queryClient, userId, context.optimisticThread);
    },
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
  readonly optimisticThread?: OptimisticThreadData;
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
      queryClient.setQueryData<ThreadDetailData>(
        threadKeys.detail(userId, thread.id),
        (detail) => (detail === undefined ? detail : { ...detail, ...thread }),
      );
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
    }: {
      threadId: ThreadId;
      archived: boolean;
    }) => setThreadArchived(threadId, archived),
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
                pages: current.pages.map((page) => ({
                  ...page,
                  items: page.items.flatMap((thread) => {
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
                })),
              },
        );
      }
      return { previousDetail, previousLists };
    },
    onSuccess: (thread: ThreadData) => {
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
