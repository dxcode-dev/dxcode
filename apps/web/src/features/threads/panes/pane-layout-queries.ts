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
import {
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
    queryFn: async ({ signal }) =>
      repairPaneLayout(
        (await getThreadPaneLayout(threadId, signal)) ?? defaultPaneLayout(),
      ),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: 1,
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
