import type { ThreadPaneLayout } from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import {
  type QueryClient,
  queryOptions,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  getThreadPaneLayout,
  putThreadPaneLayout,
} from "../../../shared/api/client.js";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { retryQuery } from "../../../shared/query/query-retry.js";
import { closeTerminalSession } from "../../terminal/terminal-session-mutations.js";
import { threadQueryOptions } from "../thread-queries.js";
import {
  closedTerminalSessions,
  defaultPaneLayout,
  type PaneLayoutAction,
  reducePaneLayout,
  repairPaneLayout,
} from "./pane-layout.js";

/** How long after the last change the layout is written to the server. */
export const PANE_LAYOUT_SAVE_DELAY_MS = 600;

export const paneLayoutKeys = {
  /**
   * Its own root, not under the Thread detail: a realtime Thread
   * invalidation must not refetch the layout over edits not yet saved.
   */
  layout: (userId: UserId, threadId: ThreadId) =>
    ["thread-pane-layout", userId, threadId] as const,
};

/**
 * The Thread as the Thread page loads it: its cached detail, or the request
 * already in flight, which the page starts before this layout's. Never a
 * request of its own, so opening a Thread reads its detail once.
 */
const loadedThread = (
  client: QueryClient,
  userId: UserId,
  threadId: ThreadId,
) => {
  const options = threadQueryOptions(userId, threadId);
  const cached = client.getQueryData(options.queryKey);
  if (
    cached !== undefined ||
    client.isFetching({ queryKey: options.queryKey, exact: true }) === 0
  )
    return Promise.resolve(cached);
  // Joins the request in flight; ensureQueryData does not start another.
  return client.ensureQueryData(options).catch(() => undefined);
};

/**
 * The person's panes and tabs on the Thread, repaired to fit, or the default
 * layout. Fetched once per session: another device's changes show on the
 * next load; this device's edits are written back debounced.
 */
export const threadPaneLayoutQueryOptions = (
  userId: UserId,
  threadId: ThreadId,
) =>
  queryOptions({
    queryKey: paneLayoutKeys.layout(userId, threadId),
    queryFn: async ({ signal, client }) =>
      repairPaneLayout(
        (await getThreadPaneLayout(threadId, signal)) ??
          // A plugin Thread type's first layout, loaded only for one.
          ((await loadedThread(client, userId, threadId))?.pluginThreadType ===
          undefined
            ? undefined
            : await (
                await import("./thread-type-layout.js")
              ).firstThreadTypeLayout(client, threadId)) ??
          defaultPaneLayout(),
      ),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    // Once after a network failure or a 5xx; never after a 4xx, such as a
    // Thread that does not exist or is hidden.
    retry: retryQuery,
    // A layout that failed to load leaves the default panes; mounting the
    // page again does not read it again.
    retryOnMount: false,
  });

interface PendingSave {
  readonly timer: ReturnType<typeof setTimeout>;
  readonly layout: ThreadPaneLayout;
}

const pendingSaves = new Map<string, PendingSave>();

const save = (threadId: ThreadId, layout: ThreadPaneLayout) =>
  putThreadPaneLayout(threadId, layout).catch(() => {
    // The layout stays as shown; the next change tries again.
  });

const flushPendingSaves = () => {
  for (const [threadId, pending] of pendingSaves) {
    clearTimeout(pending.timer);
    pendingSaves.delete(threadId);
    void save(threadId as ThreadId, pending.layout);
  }
};

if (typeof document !== "undefined")
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushPendingSaves();
  });

const scheduleSave = (threadId: ThreadId, layout: ThreadPaneLayout) => {
  const pending = pendingSaves.get(threadId);
  if (pending !== undefined) clearTimeout(pending.timer);
  pendingSaves.set(threadId, {
    layout,
    timer: setTimeout(() => {
      pendingSaves.delete(threadId);
      void save(threadId, layout);
    }, PANE_LAYOUT_SAVE_DELAY_MS),
  });
};

/**
 * Applies one layout action to the cached layout and schedules the save.
 * A Terminal whose tab it closed ends its shell session.
 * Before the layout has loaded the action applies to the default layout and
 * the fetch is cancelled, so what the person did is never undone by it.
 */
export const dispatchPaneLayoutAction = (
  client: QueryClient,
  userId: UserId,
  threadId: ThreadId,
  action: PaneLayoutAction,
) => {
  const key = paneLayoutKeys.layout(userId, threadId);
  const current = client.getQueryData<ThreadPaneLayout>(key);
  if (current === undefined) void client.cancelQueries({ queryKey: key });
  const base = current ?? defaultPaneLayout();
  const next = reducePaneLayout(base, action);
  if (next === base && current !== undefined) return next;
  client.setQueryData(key, next);
  scheduleSave(threadId, next);
  for (const session of closedTerminalSessions(base, next))
    closeTerminalSession(threadId, session);
  return next;
};

/** A dispatcher for the Thread's layout that does not subscribe to it. */
export function usePaneLayoutDispatch(threadId: ThreadId) {
  const client = useQueryClient();
  const { identity } = useAuthenticatedIdentity();
  const userId = identity.id;
  return (action: PaneLayoutAction) => {
    dispatchPaneLayoutAction(client, userId, threadId, action);
  };
}

/** The Thread's layout, subscribed; undefined while it first loads. */
export function usePaneLayout(threadId: ThreadId) {
  const { identity } = useAuthenticatedIdentity();
  const query = useQuery(threadPaneLayoutQueryOptions(identity.id, threadId));
  const dispatch = usePaneLayoutDispatch(threadId);
  // A failed load shows the default layout; edits still save.
  const layout =
    query.data ?? (query.isError ? defaultPaneLayout() : undefined);
  return { layout, dispatch };
}

/** Reads the cached layout without subscribing, for handlers. */
export function usePaneLayoutReader(threadId: ThreadId) {
  const client = useQueryClient();
  const { identity } = useAuthenticatedIdentity();
  const key = paneLayoutKeys.layout(identity.id, threadId);
  return () =>
    client.getQueryData<ThreadPaneLayout>(key) ?? defaultPaneLayout();
}
