import type {
  PersonalAccountData,
  ProjectData,
  SettingsContextData,
  ThreadData,
} from "@dx/api";
import type { UserId } from "@dx/domain";
import { useDebouncer } from "@tanstack/react-pacer";
import { Link, useLocation } from "@tanstack/react-router";
import { Search, SquarePen } from "lucide-react";
import * as React from "react";
import { useNewThreadSurface } from "../../shared/new-thread-surface.js";
import { useThreadArchive } from "../../shared/thread-archive.js";
import { Button } from "../../shared/ui/button.js";
import { SidebarAccountMenu } from "./sidebar-account-menu.js";
import { SidebarArchive } from "./sidebar-archive.js";
import { ProjectsIcon } from "./sidebar-icons.js";
import { SidebarPanelIcon } from "./sidebar-panel-icon.js";
import { SidebarThreadNavigation } from "./sidebar-thread-navigation.js";
import { buildThreadSections } from "./sidebar-thread-utils.js";
import {
  ThreadHoverPreview,
  type ThreadPreviewAnchor,
} from "./thread-hover-preview.js";

interface PreviewState {
  readonly anchor: ThreadPreviewAnchor;
  readonly projectName: string;
  readonly thread: ThreadData;
}

// A first preview requires a 500 ms dwell (trailing only; never flushed).
// Leaving cancels it. Once primed, switching rows stays immediate.
const PREVIEW_OPEN_INTENT_MS = 500;
const noop = () => undefined;
// 160 ms bridges the pointer gap from a row to its preview (trailing only;
// never flushed). Re-entry and unmount cancel the pending close.
const PREVIEW_CLOSE_GRACE_MS = 160;

const useThreadPreviewIntent = () => {
  const [preview, setPreview] = React.useState<PreviewState>();
  const previewPrimed = React.useRef(false);
  const hoveredThreadId = React.useRef<ThreadData["id"] | undefined>(undefined);
  const suppressedThreadId = React.useRef<ThreadData["id"] | undefined>(
    undefined,
  );
  const openPreviewAfterIntent = useDebouncer(
    (nextPreview: PreviewState) => {
      previewPrimed.current = true;
      setPreview(nextPreview);
    },
    {
      wait: PREVIEW_OPEN_INTENT_MS,
      leading: false,
      trailing: true,
    },
  );
  const closePreviewAfterGrace = useDebouncer(
    () => {
      previewPrimed.current = false;
      setPreview(undefined);
    },
    {
      wait: PREVIEW_CLOSE_GRACE_MS,
      leading: false,
      trailing: true,
    },
  );
  const cancelPreviewIntent = React.useCallback(() => {
    openPreviewAfterIntent.cancel();
    closePreviewAfterGrace.cancel();
  }, [closePreviewAfterGrace, openPreviewAfterIntent]);
  const sidebarLifecycleRef = React.useCallback(
    (node: HTMLElement | null) => {
      if (node === null) cancelPreviewIntent();
      return cancelPreviewIntent;
    },
    [cancelPreviewIntent],
  );
  // Stable: memoized sidebar rows receive these handlers.
  const openPreview = React.useCallback(
    (thread: ThreadData, projectName: string, element: HTMLElement) => {
      hoveredThreadId.current = thread.id;
      closePreviewAfterGrace.cancel();
      openPreviewAfterIntent.cancel();
      if (suppressedThreadId.current === thread.id) return;
      suppressedThreadId.current = undefined;
      const bounds = element.getBoundingClientRect();
      const nextPreview = {
        anchor: { right: bounds.right, top: bounds.top },
        projectName,
        thread,
      };
      if (previewPrimed.current) {
        previewPrimed.current = true;
        setPreview(nextPreview);
        return;
      }
      openPreviewAfterIntent.maybeExecute(nextPreview);
    },
    [closePreviewAfterGrace, openPreviewAfterIntent],
  );
  const leaveThreadRow = React.useCallback(
    (threadId: ThreadData["id"]) => {
      if (hoveredThreadId.current === threadId)
        hoveredThreadId.current = undefined;
      if (suppressedThreadId.current === threadId)
        suppressedThreadId.current = undefined;
      openPreviewAfterIntent.cancel();
      closePreviewAfterGrace.maybeExecute();
    },
    [closePreviewAfterGrace, openPreviewAfterIntent],
  );
  const dismissPreviewForNavigation = React.useCallback(
    (threadId: ThreadData["id"]) => {
      openPreviewAfterIntent.cancel();
      closePreviewAfterGrace.cancel();
      previewPrimed.current = false;
      suppressedThreadId.current =
        hoveredThreadId.current === threadId ? threadId : undefined;
      setPreview(undefined);
    },
    [closePreviewAfterGrace, openPreviewAfterIntent],
  );

  return {
    preview,
    openPreview,
    leaveThreadRow,
    dismissPreviewForNavigation,
    schedulePreviewClose: () => {
      openPreviewAfterIntent.cancel();
      closePreviewAfterGrace.maybeExecute();
    },
    keepPreviewOpen: () => closePreviewAfterGrace.cancel(),
    sidebarLifecycleRef,
  };
};

const usePendingProjectlessCreation = (
  surface: ReturnType<typeof useNewThreadSurface>,
  threadId: string | undefined,
) => {
  const subscribe = React.useCallback(
    (listener: () => void) =>
      surface.subscribePendingProjectlessCreation?.(listener) ??
      (() => undefined),
    [surface],
  );
  const snapshot = React.useCallback(() => {
    if (threadId === undefined) return undefined;
    return surface.pendingProjectlessCreation?.(threadId);
  }, [surface, threadId]);
  return React.useSyncExternalStore(subscribe, snapshot, snapshot);
};

export function AppSidebar({
  userId,
  archiveAvailable = userId !== undefined,
  projects,
  threads,
  personalAccount,
  settingsContext,
  onCollapse,
  collapseLabel = "Collapse sidebar",
  onNavigate,
  onOpenSearch = noop,
  searchTriggerRef,
  onLoadMore,
  loadingMore,
  hasMore,
  loadMoreError,
  onSetPinned = noop,
  pinningThreadId,
  extensionRegion,
}: {
  readonly userId?: UserId;
  readonly archiveAvailable?: boolean;
  readonly projects: ReadonlyArray<ProjectData>;
  readonly threads: ReadonlyArray<ThreadData>;
  readonly personalAccount?: PersonalAccountData;
  readonly settingsContext?: SettingsContextData;
  readonly onCollapse: () => void;
  readonly collapseLabel?: "Close sidebar" | "Collapse sidebar";
  readonly onNavigate: () => void;
  readonly onOpenSearch?: () => void;
  readonly searchTriggerRef?: React.RefObject<HTMLButtonElement | null>;
  readonly onLoadMore: () => void;
  readonly loadingMore: boolean;
  readonly hasMore: boolean;
  readonly loadMoreError?: string;
  readonly onSetPinned?: (threadId: ThreadData["id"], pinned: boolean) => void;
  readonly pinningThreadId?: ThreadData["id"];
  readonly extensionRegion?: React.ReactNode;
}) {
  const newThreadSurface = useNewThreadSurface();
  const { openNewThread } = newThreadSurface;
  const archive = useThreadArchive();
  const pathname = useLocation({ select: (location) => location.pathname });
  const activeThreadId = pathname.startsWith("/threads/")
    ? pathname.slice("/threads/".length)
    : undefined;
  const pendingCreation = usePendingProjectlessCreation(
    newThreadSurface,
    activeThreadId,
  );
  const [collapsedGroups, setCollapsedGroups] = React.useState<
    ReadonlySet<string>
  >(() => new Set(["inactive", "archived"]));
  const {
    dismissPreviewForNavigation,
    keepPreviewOpen,
    leaveThreadRow,
    openPreview,
    preview,
    schedulePreviewClose,
    sidebarLifecycleRef,
  } = useThreadPreviewIntent();
  const projectNames = React.useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects],
  );
  const onThreadNavigate = React.useCallback(
    (threadId: ThreadData["id"]) => {
      dismissPreviewForNavigation(threadId);
      onNavigate();
    },
    [dismissPreviewForNavigation, onNavigate],
  );
  const sections = buildThreadSections(
    projects,
    threads,
    Date.now(),
    archiveAvailable,
  );

  const toggleGroup = (groupId: string) => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };
  return (
    <aside
      className="sidebar product-sidebar"
      data-command-surface="sidebar"
      data-command-workspace-slug={settingsContext?.workspace?.shortName}
      ref={sidebarLifecycleRef}
    >
      <div className="sidebar-topbar">
        <Button
          aria-label={collapseLabel}
          data-command-action="toggle-sidebar"
          title={collapseLabel}
          className="sidebar-panel-control"
          variant="ghost"
          size="icon-xs"
          onClick={onCollapse}
        >
          <SidebarPanelIcon />
        </Button>
        <Link
          to="/"
          className="dx-wordmark"
          aria-label="DX home"
          onClick={onNavigate}
        >
          dx
        </Link>
        <span className="sidebar-top-spacer" />
        <Button
          ref={searchTriggerRef}
          aria-label="Search threads"
          data-command-action="search-threads"
          variant="ghost"
          size="icon-xs"
          onClick={() => {
            if (collapseLabel === "Close sidebar") onNavigate();
            onOpenSearch();
          }}
        >
          <Search />
        </Button>
        <button
          type="button"
          className="sidebar-new-thread"
          aria-label="New thread"
          onClick={() => {
            onNavigate();
            openNewThread();
          }}
        >
          <SquarePen />
        </button>
      </div>

      <SidebarThreadNavigation
        archiveContent={
          userId === undefined ? undefined : (
            <SidebarArchive
              userId={userId}
              activeThreadId={activeThreadId}
              projectNames={projectNames}
              onThreadNavigate={onThreadNavigate}
              onThreadPointerEnter={openPreview}
              onThreadPointerLeave={leaveThreadRow}
              onSetArchived={archive.setArchived}
              onSetPinned={onSetPinned}
              archivingThreadId={archive.pendingThreadId}
              pinningThreadId={pinningThreadId}
            />
          )
        }
        activeThreadId={activeThreadId}
        pendingCreation={pendingCreation}
        collapsedGroups={collapsedGroups}
        hasMore={hasMore}
        loadingMore={loadingMore}
        loadMoreError={loadMoreError}
        projectNames={projectNames}
        query=""
        sections={sections}
        visibleThreadCount={threads.length}
        onLoadMore={onLoadMore}
        onNavigate={onNavigate}
        onThreadNavigate={onThreadNavigate}
        onThreadPointerEnter={openPreview}
        onThreadPointerLeave={leaveThreadRow}
        onToggleGroup={toggleGroup}
        onSetArchived={archive.setArchived}
        onSetPinned={onSetPinned}
        archivingThreadId={archive.pendingThreadId}
        pinningThreadId={pinningThreadId}
      />

      {extensionRegion}

      <nav className="sidebar-dock" aria-label="Primary navigation">
        <Link
          to="/projects"
          className={`dock-link ${pathname === "/projects" ? "selected" : ""}`}
          onClick={onNavigate}
        >
          <ProjectsIcon />
          <span>Projects</span>
        </Link>
      </nav>

      <SidebarAccountMenu
        personalAccount={personalAccount}
        settingsContext={settingsContext}
        onNavigate={onNavigate}
      />
      {preview === undefined || userId === undefined ? null : (
        <ThreadHoverPreview
          key={preview.thread.id}
          {...preview}
          thread={
            threads.find((thread) => thread.id === preview.thread.id) ??
            preview.thread
          }
          onPointerEnter={keepPreviewOpen}
          onPointerLeave={schedulePreviewClose}
        />
      )}
    </aside>
  );
}
