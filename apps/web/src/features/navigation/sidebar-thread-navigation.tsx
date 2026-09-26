import type { ThreadData } from "@dx/api";
import { ChevronDown, FolderGit2 } from "lucide-react";
import type { ReactNode } from "react";
import {
  type PendingProjectlessCreation,
  useNewThreadSurface,
} from "../../shared/new-thread-surface.js";
import { Button } from "../../shared/ui/button.js";
import {
  SidebarPendingThreadRow,
  SidebarThreadRows,
} from "./sidebar-thread-rows.js";
import type { ThreadSection } from "./sidebar-thread-utils.js";

export function SidebarThreadNavigation({
  archiveContent,
  activeThreadId,
  pendingCreation,
  collapsedGroups,
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
  onToggleGroup,
  onSetArchived,
  onSetPinned,
  archivingThreadId,
  pinningThreadId,
}: {
  readonly archiveContent?: ReactNode;
  readonly activeThreadId?: string;
  readonly pendingCreation?: PendingProjectlessCreation;
  readonly collapsedGroups: ReadonlySet<string>;
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
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
  readonly onToggleGroup: (groupId: string) => void;
  readonly onSetArchived: (
    threadId: ThreadData["id"],
    archived: boolean,
  ) => void;
  readonly onSetPinned: (threadId: ThreadData["id"], pinned: boolean) => void;
  readonly archivingThreadId?: ThreadData["id"];
  readonly pinningThreadId?: ThreadData["id"];
}) {
  const { openNewThread } = useNewThreadSurface();
  const canonicalPendingCreation =
    pendingCreation !== undefined &&
    sections.some((section) =>
      section.threads.some((thread) => thread.id === pendingCreation.id),
    );
  const empty =
    visibleThreadCount === 0 &&
    pendingCreation === undefined &&
    !loadingMore &&
    loadMoreError === undefined &&
    (archiveContent === undefined || collapsedGroups.has("archived"));
  return (
    <nav
      className={`sidebar-scroll ${empty && query.length === 0 ? "sidebar-scroll-empty" : ""}`}
      aria-label="Threads"
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
      {pendingCreation === undefined || canonicalPendingCreation ? null : (
        <SidebarPendingThreadRow
          creation={pendingCreation}
          activeThreadId={activeThreadId}
          onThreadNavigate={onThreadNavigate}
        />
      )}
      {sections.map((section) => {
        const collapsed =
          section.label !== undefined && collapsedGroups.has(section.id);
        return (
          <section
            className="thread-project-group"
            data-thread-section={section.id}
            key={section.id}
          >
            {section.label === undefined ? null : (
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
            )}
            {collapsed ? null : section.id === "archived" &&
              archiveContent !== undefined ? (
              archiveContent
            ) : (
              <SidebarThreadRows
                threads={section.threads}
                activeThreadId={activeThreadId}
                projectNames={projectNames}
                onThreadNavigate={onThreadNavigate}
                onThreadPointerEnter={onThreadPointerEnter}
                onThreadPointerLeave={onThreadPointerLeave}
                onSetArchived={onSetArchived}
                onSetPinned={onSetPinned}
                archivingThreadId={archivingThreadId}
                pinningThreadId={pinningThreadId}
              />
            )}
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
        <div className="sidebar-empty">{loadMoreError}</div>
      )}
    </nav>
  );
}
