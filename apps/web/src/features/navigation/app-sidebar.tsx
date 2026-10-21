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
import type { ThreadListClientItem } from "../../shared/api/client.js";
import { AppUpdateRow } from "../../shared/app-update/app-update-row.js";
import { useNowMinute } from "../../shared/hooks/use-clock.js";
import {
  type PendingThreadCreation,
  useNewThreadSurface,
} from "../../shared/new-thread-surface.js";
import { useThreadArchive } from "../../shared/thread-archive.js";
import { Button } from "../../shared/ui/button.js";
import { NotificationInbox } from "./notification-inbox.js";
import { SidebarAccountMenu } from "./sidebar-account-menu.js";
import { SidebarArchive } from "./sidebar-archive.js";
import { ProjectsIcon } from "./sidebar-icons.js";
import {
  type SidebarLayout,
  useLocalSidebarLayout,
  useSyncedSidebarLayout,
} from "./sidebar-layout.js";
import { SidebarPanelIcon } from "./sidebar-panel-icon.js";
import { SidebarThreadNavigation } from "./sidebar-thread-navigation.js";
import {
  buildThreadSections,
  withPendingThreads,
} from "./sidebar-thread-utils.js";
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
  const cancelPreviewIntent = () => {
    openPreviewAfterIntent.cancel();
    closePreviewAfterGrace.cancel();
  };
  const sidebarLifecycleRef = (node: HTMLElement | null) => {
    if (node === null) cancelPreviewIntent();
    return cancelPreviewIntent;
  };
  // Stable: memoized sidebar rows receive these handlers.
  const openPreview = (
    thread: ThreadData,
    projectName: string,
    element: HTMLElement,
  ) => {
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
  };
  const leaveThreadRow = (threadId: ThreadData["id"]) => {
    if (hoveredThreadId.current === threadId)
      hoveredThreadId.current = undefined;
    if (suppressedThreadId.current === threadId)
      suppressedThreadId.current = undefined;
    openPreviewAfterIntent.cancel();
    closePreviewAfterGrace.maybeExecute();
  };
  const dismissPreviewForNavigation = (threadId: ThreadData["id"]) => {
    openPreviewAfterIntent.cancel();
    closePreviewAfterGrace.cancel();
    previewPrimed.current = false;
    suppressedThreadId.current =
      hoveredThreadId.current === threadId ? threadId : undefined;
    setPreview(undefined);
  };

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

const noPendingCreations: ReadonlyArray<PendingThreadCreation> = [];
const readNoPendingCreations = () => noPendingCreations;
const subscribeNothing = () => () => undefined;

const usePendingCreations = (
  surface: ReturnType<typeof useNewThreadSurface>,
) => {
  const read = surface.pendingCreations ?? readNoPendingCreations;
  return React.useSyncExternalStore(
    surface.subscribePendingCreations ?? subscribeNothing,
    read,
    read,
  );
};

// Names projects only when the projects or shared Threads change.
const createProjectNamesCache = () => {
  let last:
    | {
        readonly projects: ReadonlyArray<ProjectData>;
        readonly sharedThreads: ReadonlyArray<ThreadData> | undefined;
        readonly names: ReadonlyMap<string, string>;
      }
    | undefined;
  return (
    projects: ReadonlyArray<ProjectData>,
    sharedThreads: ReadonlyArray<ThreadData> | undefined,
  ) => {
    if (last?.projects === projects && last.sharedThreads === sharedThreads)
      return last.names;
    const names = new Map<string, string>([
      ...(sharedThreads ?? []).flatMap((thread) =>
        thread.projectName === undefined
          ? []
          : [[thread.projectId, thread.projectName] as const],
      ),
      ...projects.map((project) => [project.id, project.name] as const),
    ]);
    last = { projects, sharedThreads, names };
    return names;
  };
};

/**
 * Project names by id. A hook, so the sidebar receives them frozen: the
 * pending-thread merge reads them, which would otherwise cache them with the
 * Thread list and give every row new names on each list change.
 */
const useProjectNames = (
  projects: ReadonlyArray<ProjectData>,
  sharedThreads: ReadonlyArray<ThreadData> | undefined,
) => {
  const [namesFor] = React.useState(createProjectNamesCache);
  return namesFor(projects, sharedThreads);
};

export interface AppSidebarProps {
  readonly userId?: UserId;
  readonly archiveAvailable?: boolean;
  readonly projects: ReadonlyArray<ProjectData>;
  /** Every Project the user can see is loaded, so unnamed ones are hidden. */
  readonly projectsComplete?: boolean;
  readonly threads: ReadonlyArray<ThreadData>;
  /** Shared Threads of other workspace members that this user follows. */
  readonly sharedThreads?: ReadonlyArray<ThreadData>;
  readonly onUnfollow?: (threadId: ThreadData["id"]) => void;
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
  /** Each listed root's child Threads, loaded with the roots. */
  readonly childThreads?: ReadonlyMap<
    ThreadData["id"],
    ReadonlyArray<ThreadListClientItem>
  >;
}

/** The sidebar, with the person's synced layout when signed in. */
export function AppSidebar(props: AppSidebarProps) {
  return props.userId === undefined ? (
    <LocalLayoutSidebar {...props} />
  ) : (
    <SyncedLayoutSidebar {...props} userId={props.userId} />
  );
}

function SyncedLayoutSidebar(
  props: AppSidebarProps & { readonly userId: UserId },
) {
  return (
    <AppSidebarContent
      {...props}
      layout={useSyncedSidebarLayout(props.userId)}
    />
  );
}

function LocalLayoutSidebar(props: AppSidebarProps) {
  return <AppSidebarContent {...props} layout={useLocalSidebarLayout()} />;
}

function AppSidebarContent({
  userId,
  archiveAvailable: archiveAvailableProp,
  projects,
  projectsComplete = false,
  threads,
  sharedThreads,
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
  onUnfollow,
  pinningThreadId,
  extensionRegion,
  childThreads,
  layout,
}: AppSidebarProps & { readonly layout: SidebarLayout }) {
  const archiveAvailable = archiveAvailableProp ?? userId !== undefined;
  const newThreadSurface = useNewThreadSurface();
  const { openNewThread } = newThreadSurface;
  const archive = useThreadArchive();
  const pathname = useLocation({ select: (location) => location.pathname });
  const activeThreadId = pathname.startsWith("/threads/")
    ? pathname.slice("/threads/".length)
    : undefined;
  const pendingCreations = usePendingCreations(newThreadSurface);
  const {
    dismissPreviewForNavigation,
    keepPreviewOpen,
    leaveThreadRow,
    openPreview,
    preview,
    schedulePreviewClose,
    sidebarLifecycleRef,
  } = useThreadPreviewIntent();
  const now = useNowMinute();
  const projectNames = useProjectNames(projects, sharedThreads);
  const onThreadNavigate = (threadId: ThreadData["id"]) => {
    dismissPreviewForNavigation(threadId);
    onNavigate();
  };
  const listedThreads = withPendingThreads(
    threads,
    pendingCreations,
    projectNames,
    projectsComplete,
  );
  const sections = buildThreadSections(
    projects,
    listedThreads,
    now,
    archiveAvailable,
    sharedThreads,
  );

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
        {userId === undefined ? null : (
          <NotificationInbox userId={userId} onNavigate={onNavigate} />
        )}
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
              onThreadMenuOpen={dismissPreviewForNavigation}
              onSetArchived={archive.setArchived}
              onSetPinned={onSetPinned}
              archivingThreadId={archive.pendingThreadId}
              pinningThreadId={pinningThreadId}
            />
          )
        }
        activeThreadId={activeThreadId}
        childThreads={childThreads}
        collapsedGroups={layout.collapsedSections}
        expandedThreads={layout.expandedThreads}
        hasMore={hasMore}
        loadingMore={loadingMore}
        loadMoreError={loadMoreError}
        projectNames={projectNames}
        query=""
        sections={sections}
        visibleThreadCount={listedThreads.length + (sharedThreads?.length ?? 0)}
        onLoadMore={onLoadMore}
        onNavigate={onNavigate}
        onThreadNavigate={onThreadNavigate}
        onThreadPointerEnter={openPreview}
        onThreadPointerLeave={leaveThreadRow}
        onThreadMenuOpen={dismissPreviewForNavigation}
        onToggleGroup={layout.toggleSection}
        onToggleThread={layout.toggleThread}
        onUnfollow={onUnfollow}
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

      <AppUpdateRow />
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
