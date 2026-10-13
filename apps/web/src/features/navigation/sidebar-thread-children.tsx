import type { ThreadData } from "@dx/api";
import { PROJECTLESS_PROJECT_NAME } from "@dx/domain";
import { useInfiniteQuery } from "@tanstack/react-query";
import * as React from "react";
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

/**
 * Which parent Threads show their child Threads. Shared by every section
 * and the archive, so a parent stays expanded when it moves between them.
 */
const noThreads: ReadonlySet<ThreadData["id"]> = new Set();

export function SidebarThreadChildrenProvider({
  listed = noThreads,
  children,
}: {
  readonly listed?: ReadonlySet<ThreadData["id"]>;
  readonly children: React.ReactNode;
}) {
  const [expanded, setExpanded] = React.useState<ReadonlySet<ThreadData["id"]>>(
    () => new Set(),
  );
  const toggle = React.useCallback((threadId: ThreadData["id"]) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(threadId)) next.add(threadId);
      return next;
    });
  }, []);
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

/** A parent's child Threads, loaded when the parent is expanded. */
export function SidebarChildThreadRows({
  parent,
  activeThreadId,
  projectNames,
  archivingThreadId,
  pinningThreadId,
  ...handlers
}: SidebarThreadListProps & {
  readonly parent: ThreadData;
}) {
  const { identity } = useAuthenticatedIdentity();
  const listed = useThreadChildrenExpansion()?.listed;
  const query = useInfiniteQuery(
    threadsQueryOptions(
      identity.id,
      undefined,
      parent.lifecycleState,
      parent.id,
    ),
  );
  // The two lists refresh separately: a child that moved to the sections,
  // such as one just pinned, must not show twice, nor be selected twice.
  const children =
    query.data?.pages.flatMap((page) =>
      page.items.filter((thread) => listed?.has(thread.id) !== true),
    ) ?? [];
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
      {query.isError ? (
        <button
          type="button"
          className="thread-children-more"
          onClick={() =>
            void (query.isFetchNextPageError
              ? query.fetchNextPage()
              : query.refetch())
          }
        >
          Could not load threads. Retry
        </button>
      ) : query.hasNextPage ? (
        <button
          type="button"
          className="thread-children-more"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? "Loading…" : "Load more threads"}
        </button>
      ) : null}
    </div>
  );
}
