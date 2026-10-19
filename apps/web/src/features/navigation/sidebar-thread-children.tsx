import type { ThreadData } from "@dx/api";
import { PROJECTLESS_PROJECT_NAME } from "@dx/domain";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import type { ThreadListClientItem } from "../../shared/api/client.js";
import { useAuthenticatedIdentity } from "../../shared/auth/auth-context.js";
import { threadsQueryOptions } from "../threads/thread-queries.js";
import {
  type SidebarThreadListProps,
  SidebarThreadRow,
} from "./sidebar-thread-row.js";

export interface ThreadChildrenExpansion {
  readonly expanded: ReadonlySet<ThreadData["id"]>;
  readonly toggle: (threadId: ThreadData["id"]) => void;
  /** Threads the sections already list, which no parent repeats. */
  readonly listed: ReadonlySet<ThreadData["id"]>;
}

const ThreadChildrenExpansionContext = React.createContext<
  ThreadChildrenExpansion | undefined
>(undefined);

const noThreads: ReadonlySet<ThreadData["id"]> = new Set();

/**
 * Which parent Threads show their child Threads, from the sidebar layout.
 * Shared by every section and the archive, so a parent stays expanded when
 * it moves between them.
 */
export function SidebarThreadChildrenProvider({
  listed = noThreads,
  expanded,
  toggle,
  children,
}: {
  readonly listed?: ReadonlySet<ThreadData["id"]>;
  readonly expanded: ReadonlySet<ThreadData["id"]>;
  readonly toggle: (threadId: ThreadData["id"]) => void;
  readonly children: React.ReactNode;
}) {
  const value = React.useMemo(
    () => ({ expanded, toggle, listed }),
    [expanded, toggle, listed],
  );
  return (
    <ThreadChildrenExpansionContext.Provider value={value}>
      {children}
    </ThreadChildrenExpansionContext.Provider>
  );
}

/** The sidebar's expansion owner; undefined outside the sidebar. */
export const useThreadChildrenExpansion = () =>
  React.useContext(ThreadChildrenExpansionContext);

/**
 * A parent's child Threads. They arrive with the roots list, so expanding
 * shows them without a request; only a parent with more children than the
 * list carries pages the rest on demand.
 */
export function SidebarChildThreadRows({
  parent,
  loaded,
  activeThreadId,
  projectNames,
  archivingThreadId,
  pinningThreadId,
  ...handlers
}: SidebarThreadListProps & {
  readonly parent: ThreadListClientItem;
  readonly loaded: ReadonlyArray<ThreadListClientItem>;
}) {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const listed = useThreadChildrenExpansion()?.listed;
  const options = threadsQueryOptions(
    identity.id,
    undefined,
    parent.lifecycleState === "archived" ? "archived" : "active",
    parent.id,
  );
  const [pagingRest, setPagingRest] = React.useState(false);
  const paged = useInfiniteQuery({ ...options, enabled: pagingRest });
  const pages = pagingRest ? paged.data?.pages : undefined;
  // The two lists refresh separately: a child that moved to the sections,
  // such as one just pinned, must not show twice, nor be selected twice.
  const children = (pages?.flatMap((page) => page.items) ?? loaded).filter(
    (thread) => listed?.has(thread.id) !== true,
  );
  const hasMore =
    pages === undefined
      ? (parent.childCount ?? 0) > loaded.length
      : paged.hasNextPage;
  const loadMore = () => {
    if (pages !== undefined) return void paged.fetchNextPage();
    setPagingRest(true);
    // The first page repeats what the roots list carried.
    void queryClient.prefetchInfiniteQuery({ ...options, pages: 2 });
  };
  return (
    <div className="thread-children">
      {children.map((thread) => (
        <SidebarThreadRow
          key={thread.id}
          thread={thread}
          projectName={
            projectNames.get(thread.projectId) ?? PROJECTLESS_PROJECT_NAME
          }
          selected={thread.id === activeThreadId}
          archiving={archivingThreadId === thread.id}
          pinning={pinningThreadId === thread.id}
          child
          {...handlers}
        />
      ))}
      {pagingRest && paged.isError ? (
        <button
          type="button"
          className="thread-children-more"
          onClick={() =>
            void (paged.isFetchNextPageError
              ? paged.fetchNextPage()
              : paged.refetch())
          }
        >
          Could not load threads. Retry
        </button>
      ) : hasMore ? (
        <button
          type="button"
          className="thread-children-more"
          disabled={pagingRest && (paged.isFetching || paged.isPending)}
          onClick={loadMore}
        >
          {pagingRest && (paged.isFetching || paged.isPending)
            ? "Loading…"
            : "Load more threads"}
        </button>
      ) : null}
    </div>
  );
}
