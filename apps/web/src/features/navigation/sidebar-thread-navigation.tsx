import type { ThreadData } from "@dx/api";
import { Archive, ChevronDown, FolderGit2 } from "lucide-react";
import type { ReactNode } from "react";
import type { ThreadListClientItem } from "../../shared/api/client.js";
import { useNewThreadSurface } from "../../shared/new-thread-surface.js";
import { Button } from "../../shared/ui/button.js";
import { SidebarThreadChildrenProvider } from "./sidebar-thread-children.js";
import { SidebarThreadRows } from "./sidebar-thread-rows.js";
import type { ThreadSection } from "./sidebar-thread-utils.js";

export function SidebarThreadNavigation({
  archiveContent,
  activeThreadId,
  childThreads,
  collapsedGroups,
  expandedThreads,
  hasMore,
  loadingMore,
  loadMoreError,
  projectNames,
  query,
  sections,
  visibleThreadCount,
  onLoadMore,
  onNavigate,
  onThreadNavigate,
  onThreadPointerEnter,
  onThreadPointerLeave,
  onThreadMenuOpen,
  onToggleGroup,
  onToggleThread,
  onSetArchived,
  onSetPinned,
  onUnfollow,
  onArchiveInactive,
  archivingThreadId,
  pinningThreadId,
}: {
  readonly archiveContent?: ReactNode;
  readonly activeThreadId?: string;
  readonly childThreads?: ReadonlyMap<
    ThreadData["id"],
    ReadonlyArray<ThreadListClientItem>
  >;
  readonly collapsedGroups: ReadonlySet<string>;
  readonly expandedThreads: ReadonlySet<ThreadData["id"]>;
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  /** A failed load, shown with Retry, which calls `onLoadMore`. */
  readonly loadMoreError?: string;
  readonly projectNames: ReadonlyMap<string, string>;
  readonly query: string;
  readonly sections: ReadonlyArray<ThreadSection>;
  readonly visibleThreadCount: number;
  readonly onLoadMore: () => void;
  readonly onNavigate: () => void;
  readonly onThreadNavigate: (threadId: ThreadData["id"]) => void;
  readonly onThreadPointerEnter: (
    thread: ThreadData,
    projectName: string,
    element: HTMLElement,
  ) => void;
  readonly onThreadPointerLeave: (threadId: ThreadData["id"]) => void;
  readonly onThreadMenuOpen?: (threadId: ThreadData["id"]) => void;
  readonly onToggleGroup: (groupId: string) => void;
  readonly onToggleThread: (threadId: ThreadData["id"]) => void;
  /** `includeChildren` also archives or restores the Thread's children. */
  readonly onSetArchived: (
    threadId: ThreadData["id"],
    archived: boolean,
    includeChildren?: boolean,
  ) => void;
  readonly onSetPinned: (threadId: ThreadData["id"], pinned: boolean) => void;
  readonly onUnfollow?: (threadId: ThreadData["id"]) => void;
  /** Archives every Thread listed in Inactive; absent hides the button. */
  readonly onArchiveInactive?: (
    threadIds: ReadonlyArray<ThreadData["id"]>,
  ) => void;
  readonly archivingThreadId?: ThreadData["id"];
  readonly pinningThreadId?: ThreadData["id"];
}) {
  const { openNewThread } = useNewThreadSurface();
  const listed = new Set(
    sections.flatMap(({ threads }) => threads.map(({ id }) => id)),
  );
  const empty =
    visibleThreadCount === 0 &&
    !loadingMore &&
    loadMoreError === undefined &&
    (archiveContent === undefined || collapsedGroups.has("archived"));
  return (
    <nav
      className={`sidebar-scroll ${empty && query.length === 0 ? "sidebar-scroll-empty" : ""}`}
      aria-label="Threads"
    >
      <SidebarThreadChildrenProvider
        listed={listed}
        expanded={expandedThreads}
        toggle={onToggleThread}
      >
        {empty ? (
          query.length === 0 ? (
            <div className="sidebar-first-thread">
              <svg
                viewBox="0 0 240 280"
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                <path d="M95 255 C35 190 30 105 102 100 C175 95 155 173 108 145 C60 116 175 68 222 6 M207 12 L222 6 L223 23" />
              </svg>
              <button
                type="button"
                onClick={() => {
                  onNavigate();
                  openNewThread();
                }}
              >
                Create new thread
              </button>
            </div>
          ) : (
            <div className="sidebar-empty">No matching threads</div>
          )
        ) : null}
        {/* The first page is still on its way, so nothing is listed yet. */}
        {visibleThreadCount === 0 && loadingMore && !hasMore ? (
          <div className="sidebar-empty" role="status">
            Loading threads…
          </div>
        ) : null}
        {sections.map((section) => {
          const collapsed =
            section.label !== undefined && collapsedGroups.has(section.id);
          const rows = (threads: ReadonlyArray<ThreadData>) => (
            <SidebarThreadRows
              threads={threads}
              snoozed={section.id === "snoozed"}
              inactive={section.id === "inactive"}
              childThreads={childThreads}
              activeThreadId={activeThreadId}
              projectNames={projectNames}
              onThreadNavigate={onThreadNavigate}
              onThreadPointerEnter={onThreadPointerEnter}
              onThreadPointerLeave={onThreadPointerLeave}
              onThreadMenuOpen={onThreadMenuOpen}
              onSetArchived={onSetArchived}
              onSetPinned={onSetPinned}
              onUnfollow={onUnfollow}
              archivingThreadId={archivingThreadId}
              pinningThreadId={pinningThreadId}
            />
          );
          const archivable =
            section.id === "inactive" && onArchiveInactive !== undefined
              ? section.threads.filter(
                  ({ access }) => access === undefined || access === "owner",
                )
              : [];
          const heading =
            section.label === undefined ? null : (
              <button
                className="thread-group-heading"
                data-collapsed={collapsed || undefined}
                type="button"
                onClick={() => onToggleGroup(section.id)}
                aria-expanded={!collapsed}
              >
                {section.project ? (
                  <FolderGit2
                    className="thread-group-icon"
                    aria-hidden="true"
                  />
                ) : null}
                <span>{section.label}</span>
                <i />
                <span className="thread-group-meta">
                  {section.id === "archived" &&
                  archiveContent !== undefined ? null : (
                    <small>{section.threads.length}</small>
                  )}
                  {collapsed ? null : <ChevronDown aria-hidden="true" />}
                </span>
              </button>
            );
          return (
            <section
              className="thread-project-group"
              data-thread-section={section.id}
              aria-busy={section.loading || undefined}
              key={section.id}
            >
              {archivable.length === 0 ? (
                heading
              ) : (
                <div className="thread-group-heading-row">
                  {heading}
                  <button
                    type="button"
                    className="thread-group-action"
                    aria-label="Archive inactive threads"
                    title="Archive inactive threads"
                    onClick={() =>
                      onArchiveInactive?.(archivable.map(({ id }) => id))
                    }
                  >
                    <Archive aria-hidden="true" />
                  </button>
                </div>
              )}
              {collapsed
                ? null
                : section.id === "archived" && archiveContent !== undefined
                  ? archiveContent
                  : section.groups === undefined
                    ? rows(section.threads)
                    : section.groups.map((group) => (
                        <div
                          className="thread-project-group"
                          data-thread-subgroup={group.id}
                          key={group.id}
                        >
                          <h3 className="thread-group-heading thread-subgroup-heading">
                            <FolderGit2
                              className="thread-group-icon"
                              aria-hidden="true"
                            />
                            <span>{group.label}</span>
                          </h3>
                          {rows(group.threads)}
                        </div>
                      ))}
            </section>
          );
        })}
        {hasMore ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={loadingMore}
            onClick={onLoadMore}
          >
            {loadingMore ? "Loading…" : "Load more threads"}
          </Button>
        ) : null}
        {loadMoreError === undefined ? null : (
          <div className="sidebar-empty" role="alert">
            {loadMoreError}
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={loadingMore}
              onClick={onLoadMore}
            >
              Retry
            </Button>
          </div>
        )}
      </SidebarThreadChildrenProvider>
    </nav>
  );
}
