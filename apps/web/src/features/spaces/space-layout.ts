import type { SpacePageLayout, ThreadPaneLayout } from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import {
  type QueryClient,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useAuthenticatedIdentity } from "../../shared/auth/auth-context.js";
import {
  threadPaneLayoutQueryOptions,
  updatePaneLayout,
} from "../threads/panes/pane-layout-queries.js";
import { threadQueryOptions } from "../threads/thread-queries.js";

/** A Space's page before the person changed it: no thread, Side by Side. */
export const DEFAULT_SPACE_PAGE_LAYOUT: SpacePageLayout = {
  tabs: false,
  front: "thread",
  details: "threads",
};

/** A change to the page; `thread: null` closes the open thread. */
export interface SpacePageChange {
  readonly thread?: ThreadId | null;
  readonly tabs?: boolean;
  readonly front?: SpacePageLayout["front"];
  readonly details?: SpacePageLayout["details"];
}

const applyChange = (
  layout: ThreadPaneLayout,
  change: SpacePageChange,
): ThreadPaneLayout => {
  const before = layout.space ?? DEFAULT_SPACE_PAGE_LAYOUT;
  const thread =
    change.thread === undefined ? before.thread : (change.thread ?? undefined);
  const next: SpacePageLayout = {
    ...(thread === undefined ? {} : { thread }),
    tabs: change.tabs ?? before.tabs,
    front: change.front ?? before.front,
    details: change.details ?? before.details,
  };
  if (
    layout.space !== undefined &&
    next.thread === before.thread &&
    next.tabs === before.tabs &&
    next.front === before.front &&
    next.details === before.details
  )
    return layout;
  return { ...layout, space: next };
};

/**
 * How the person left the Space's page, saved with the Space's own Thread
 * layout, so a reload or another device opens it the same way; undefined
 * while it first loads. `change` saves a change, debounced.
 */
export function useSpacePageLayout(spaceThreadId: ThreadId) {
  const { identity } = useAuthenticatedIdentity();
  const client = useQueryClient();
  const query = useQuery({
    ...threadPaneLayoutQueryOptions(identity.id, spaceThreadId),
    select: (layout) => layout.space ?? DEFAULT_SPACE_PAGE_LAYOUT,
  });
  // A layout that failed to load leaves the page as it opens; changes
  // still save.
  const layout =
    query.data ?? (query.isError ? DEFAULT_SPACE_PAGE_LAYOUT : undefined);
  const change = (next: SpacePageChange) =>
    updatePaneLayout(client, identity.id, spaceThreadId, (saved) =>
      applyChange(saved, next),
    );
  return { layout, change };
}

/**
 * A Space's page opened one of its threads (`?thread=`), by a link, a
 * notification, or the page itself: the Space remembers it, in front. The
 * same thread again changes nothing, so a reload keeps the tab in front.
 */
export const rememberOpenedSpaceThread = (
  client: QueryClient,
  userId: UserId,
  spaceThreadId: ThreadId,
  threadId: ThreadId,
) => {
  if (threadId === spaceThreadId) return;
  void client.ensureQueryData(threadQueryOptions(userId, spaceThreadId)).then(
    (thread) => {
      if (thread.kind !== "space") return;
      updatePaneLayout(client, userId, spaceThreadId, (layout) =>
        layout.space?.thread === threadId
          ? layout
          : applyChange(layout, { thread: threadId, front: "thread" }),
      );
    },
    () => undefined,
  );
};
