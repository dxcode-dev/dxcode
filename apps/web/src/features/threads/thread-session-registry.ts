import type { ThreadAgentInitializationData, ThreadDetailData } from "@dx/api";
import {
  type AbsentConversation,
  type OptimisticThreadCreation as ClientOptimisticThreadCreation,
  createThreadAgentClient as createClientThreadAgentClient,
  type RetainedThreadCore,
  type RetainedThreadEvents,
  type ThreadAgentClient,
  ThreadSessionRegistryCore,
} from "@dx/client";
import type { ProjectId, ThreadId, UserId } from "@dx/domain";
import { createFlueAgentSession, type FlueAgentSession } from "@flue/react";
import {
  hashKey,
  type QueryClient,
  QueryObserver,
} from "@tanstack/react-query";
import { sameOriginFetch } from "../../shared/same-origin-fetch.js";
import { THREAD_HISTORY_PAGE } from "../../shared/thread-history-page.js";
import { projectQueryOptions } from "../projects/project-queries.js";
import { DictationRecoverySession } from "./dictation/dictation-session.js";
import {
  createPendingAttachmentCollection,
  disposeAttachments,
  type PendingAttachment,
  type PendingAttachmentCollection,
} from "./image-attachments.js";
import { threadKeys, threadQueryOptions } from "./thread-queries.js";

export {
  type AbsentConversation,
  createPendingSubmissionControl,
  initializeRetainedThread,
  isAuthorizationError,
  isDeletedThreadError,
  type PendingSubmissionControl,
  QUIET_STREAM_MS,
  type ThreadAgentClient,
} from "@dx/client";

/** Same-origin requests, read when called so a test's stubs apply. */
const agentFetch: typeof fetch = (input, init) => sameOriginFetch(input, init);

/** `createThreadAgentClient` from `@dx/client` with the page's fetch and origin. */
export const createThreadAgentClient = (
  agentUrl: string,
  initialData: () => ThreadAgentInitializationData | undefined,
  instanceObserved?: () => boolean,
  /** The Thread's first message has not reached its agent yet. */
  awaitingAgent?: () => boolean,
  conversation?: AbsentConversation,
): ThreadAgentClient =>
  createClientThreadAgentClient({
    agentUrl,
    fetch: agentFetch,
    origin: window.location.href,
    initialData,
    instanceObserved,
    awaitingAgent,
    conversation,
  });

/** The web's parts of a retained Thread, beside its Flue session. */
interface WebThreadParts {
  readonly dictation: DictationRecoverySession;
  readonly images: PendingAttachmentCollection;
}

export type RetainedThread = RetainedThreadCore<FlueAgentSession> &
  WebThreadParts;

export type OptimisticThreadCreation =
  ClientOptimisticThreadCreation<PendingAttachment>;

/**
 * Watches a retained Thread's dx data in Query: its detail and Project for
 * access, a change to its detail, and the realtime hub's invalidation of it.
 */
const watchThread = (
  queryClient: QueryClient,
  userId: UserId,
  id: ThreadId,
  events: RetainedThreadEvents,
) => {
  const thread = new QueryObserver(queryClient, {
    ...threadQueryOptions(userId, id),
    enabled: false,
    refetchInterval: false,
  });
  let releaseProject: (() => void) | undefined;
  // The Project is known once the Thread detail loads.
  const watchProject = (projectId: ProjectId | undefined) => {
    if (releaseProject !== undefined || projectId === undefined) return;
    const project = new QueryObserver(queryClient, {
      ...projectQueryOptions(userId, projectId),
      enabled: false,
    });
    releaseProject = project.subscribe((result) => {
      // A Thread kept from a deleted Project stays readable; its
      // Project answers 404 for good.
      if (thread.getCurrentResult().data?.projectDeleted !== true)
        events.failed(result.error);
    });
  };
  let detail = thread.getCurrentResult().data;
  const releaseThread = thread.subscribe((result) => {
    watchProject(result.data?.projectId);
    events.failed(result.error);
    // Its first load comes with the history read it would repeat.
    const previous = detail;
    detail = result.data;
    if (previous === undefined || result.data === previous) return;
    events.changed();
  });
  watchProject(thread.getCurrentResult().data?.projectId);
  const detailHash = hashKey(threadKeys.detail(userId, id));
  const releaseInvalidation = queryClient.getQueryCache().subscribe((event) => {
    if (
      event.type === "updated" &&
      event.action.type === "invalidate" &&
      event.query.queryHash === detailHash
    )
      events.invalidated();
  });
  return () => {
    releaseThread();
    releaseProject?.();
    releaseInvalidation();
  };
};

/**
 * The web's Thread session registry: `ThreadSessionRegistryCore` from
 * `@dx/client` with Flue's React sessions, same-origin requests, dictation
 * and image previews, and each Thread's dx data watched in Query.
 */
export class ThreadSessionRegistry extends ThreadSessionRegistryCore<
  FlueAgentSession,
  WebThreadParts,
  PendingAttachment
> {
  constructor(queryClient: QueryClient, userId: UserId) {
    super({
      fetch: agentFetch,
      origin: () => window.location.href,
      createSession: (client) =>
        createFlueAgentSession({
          client,
          live: "sse",
          ...THREAD_HISTORY_PAGE,
        }),
      createExtra: () => ({
        dictation: new DictationRecoverySession(),
        images: createPendingAttachmentCollection(),
      }),
      disposeExtra: ({ dictation, images }) => {
        dictation.clear();
        images.dispose();
        void images.settle().then(() => images.dispose());
      },
      disposeImages: disposeAttachments,
      awaitingAgent: (id) =>
        queryClient.getQueryData<ThreadDetailData>(
          threadKeys.detail(userId, id),
        )?.initialDispatch?.state === "pending",
      watch: (id, events) => watchThread(queryClient, userId, id, events),
    });
  }
}
