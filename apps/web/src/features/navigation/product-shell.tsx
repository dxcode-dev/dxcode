import { Dialog } from "@base-ui/react/dialog";
import type { ThreadId } from "@dx/domain";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Outlet, useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { Group, Panel, usePanelRef } from "react-resizable-panels";
import { useAuthenticatedIdentity } from "../../shared/auth/auth-context.js";
import { AppFrame } from "../../shared/layout/app-frame.js";
import { ResizableDivider } from "../../shared/layout/resizable-divider.js";
import {
  collapseResizablePanel,
  expandResizablePanel,
} from "../../shared/layout/resizable-panel.js";
import { Button } from "../../shared/ui/button.js";
import { useMobile } from "../../shared/use-mobile.js";
import { projectsQueryOptions } from "../projects/project-queries.js";
import { personalAccountQueryOptions } from "../settings/account/personal-account-queries.js";
import { settingsContextQueryOptions } from "../settings/settings-context-queries.js";
import { unfollowThreadMutationOptions } from "../threads/sharing/sharing-mutations.js";
import { setThreadPinnedMutationOptions } from "../threads/thread-mutations.js";
import {
  sharedThreadsQueryOptions,
  threadsQueryOptions,
} from "../threads/thread-queries.js";
import { AppSidebar } from "./app-sidebar.js";
import { SidebarExtensionRegion } from "./sidebar-extensions.js";
import { SidebarPanelIcon } from "./sidebar-panel-icon.js";
import { childThreadsByParent } from "./sidebar-thread-utils.js";
import { ThreadSearchDialog } from "./thread-search-dialog.js";

const PRODUCT_SIDEBAR_MIN_SIZE = 250;
const PRODUCT_SIDEBAR_MAX_SIZE = 480;
const sidebarExtensionRegion = <SidebarExtensionRegion />;

export function ProductShell() {
  const navigate = useNavigate();
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const pinMutation = useMutation(
    setThreadPinnedMutationOptions(queryClient, identity.id),
  );
  const unfollowThread = useMutation(
    unfollowThreadMutationOptions(queryClient, identity.id),
  ).mutate;
  const projectsQuery = useInfiniteQuery(projectsQueryOptions(identity.id));
  const threadsQuery = useInfiniteQuery(
    threadsQueryOptions(identity.id, undefined, "active", "roots"),
  );
  const personalAccountQuery = useQuery(
    personalAccountQueryOptions(identity.id),
  );
  const settingsQuery = useQuery(settingsContextQueryOptions(identity.id));
  // Flattened once per page change so the sidebar's list memos hold.
  const projectPages = projectsQuery.data?.pages;
  const projects = projectPages?.flatMap((page) => page.items) ?? [];
  const threadPages = threadsQuery.data?.pages;
  const threads = threadPages?.flatMap((page) => page.items) ?? [];
  const childThreads = childThreadsByParent(threadPages);
  // An empty active list can still have archived Threads. Reuse the archive
  // cache so checking availability does not hide the only path to those rows.
  const checkEmptyArchive = threadsQuery.isSuccess && threads.length === 0;
  const archiveQuery = useInfiniteQuery({
    ...threadsQueryOptions(identity.id, undefined, "archived", "roots"),
    enabled: checkEmptyArchive,
  });
  const archiveAvailable =
    threads.length > 0 ||
    threadsQuery.isError ||
    archiveQuery.isError ||
    archiveQuery.data?.pages.some(
      (page) => page.items.length > 0 || page.nextCursor !== undefined,
    ) === true;
  const sidebarRef = usePanelRef();
  const expandedSidebarGrowRef = React.useRef("20");
  const mobile = useMobile();
  const [sidebarCollapsed, setSidebarCollapsed] = React.useState(false);
  // A phone opens on the page itself; the sidebar button shows the drawer.
  const [mobileSidebarOpen, setMobileSidebarOpen] = React.useState(false);
  // The drawer's sidebar mounts on first open and then stays mounted, so
  // later opens slide it in without rebuilding every row.
  const [mobileSidebarKept, setMobileSidebarKept] = React.useState(false);
  const setMobileSidebar = (open: boolean) => {
    setMobileSidebarOpen(open);
    if (open) setMobileSidebarKept(true);
  };
  const [threadSearchOpen, setThreadSearchOpen] = React.useState(false);
  const sharedThreadsQuery = useQuery(sharedThreadsQueryOptions(identity.id));
  const sidebarSearchTriggerRef = React.useRef<HTMLButtonElement>(null);
  const mobileSidebarTriggerRef = React.useRef<HTMLButtonElement>(null);
  const mobileSidebarPopupRef = React.useRef<HTMLDivElement>(null);

  const toggleSidebar = () => {
    if (mobile) {
      setMobileSidebarOpen((open) => !open);
      setMobileSidebarKept(true);
    } else {
      const panel = document.querySelector<HTMLElement>(
        ".product-panel-group > :first-child",
      );
      if (sidebarCollapsed) {
        const expandedGrow = expandedSidebarGrowRef.current;
        expandResizablePanel(panel, expandedGrow, () =>
          sidebarRef.current?.expand(),
        );
      } else {
        const currentGrow =
          panel === null ? "1" : getComputedStyle(panel).flexGrow;
        expandedSidebarGrowRef.current = currentGrow;
        collapseResizablePanel(panel, currentGrow, () =>
          sidebarRef.current?.collapse(),
        );
      }
    }
  };

  // Stable: memoized sidebar rows receive these handlers.
  const closeMobileSidebar = () => setMobileSidebarOpen(false);
  const pinThread = pinMutation.mutate;
  const setThreadPinned = (threadId: ThreadId, pinned: boolean) =>
    pinThread({ threadId, pinned });
  const openThreadSearch = () => setThreadSearchOpen(true);
  const fetchNextThreads = threadsQuery.fetchNextPage;
  const loadMoreThreads = () => void fetchNextThreads();
  const selectSearchedThread = (threadId: string) => {
    setMobileSidebarOpen(false);
    void navigate({ to: "/threads/$threadId", params: { threadId } });
  };
  const sidebar = (
    <AppSidebar
      userId={identity.id}
      archiveAvailable={archiveAvailable}
      projects={projects}
      projectsComplete={projectsQuery.isSuccess && !projectsQuery.hasNextPage}
      threads={threads}
      childThreads={childThreads}
      sharedThreads={sharedThreadsQuery.data}
      onUnfollow={unfollowThread}
      personalAccount={personalAccountQuery.data}
      settingsContext={settingsQuery.data}
      onCollapse={toggleSidebar}
      collapseLabel={mobile ? "Close sidebar" : "Collapse sidebar"}
      onNavigate={closeMobileSidebar}
      onOpenSearch={openThreadSearch}
      searchTriggerRef={sidebarSearchTriggerRef}
      onLoadMore={loadMoreThreads}
      loadingMore={
        threadsQuery.isPending ||
        threadsQuery.isFetchingNextPage ||
        (checkEmptyArchive && archiveQuery.isPending)
      }
      hasMore={threadsQuery.hasNextPage}
      loadMoreError={
        threadsQuery.error instanceof Error
          ? threadsQuery.error.message
          : undefined
      }
      onSetPinned={setThreadPinned}
      pinningThreadId={
        pinMutation.isPending ? pinMutation.variables.threadId : undefined
      }
      extensionRegion={sidebarExtensionRegion}
    />
  );

  return (
    <AppFrame className="product-shell">
      <Dialog.Root
        open={mobile && mobileSidebarOpen}
        onOpenChange={setMobileSidebar}
      >
        <Dialog.Portal keepMounted={mobile && mobileSidebarKept}>
          <Dialog.Backdrop className="mobile-sidebar-scrim" />
          <Dialog.Popup
            ref={mobileSidebarPopupRef}
            initialFocus={mobileSidebarPopupRef}
            className="mobile-sidebar-drawer"
          >
            {sidebar}
          </Dialog.Popup>
        </Dialog.Portal>
        <Group
          orientation="horizontal"
          className="product-panel-group"
          data-mobile={mobile || undefined}
        >
          <Panel
            id="product-navigation"
            className="product-navigation-panel"
            hidden={mobile}
            groupResizeBehavior="preserve-pixel-size"
            panelRef={sidebarRef}
            defaultSize="300px"
            minSize={`${PRODUCT_SIDEBAR_MIN_SIZE}px`}
            maxSize={`${PRODUCT_SIDEBAR_MAX_SIZE}px`}
            collapsible
            collapsedSize="0px"
            onResize={(size) => {
              const collapsed = size.asPercentage === 0;
              if (size.inPixels >= PRODUCT_SIDEBAR_MIN_SIZE)
                expandedSidebarGrowRef.current = String(size.asPercentage);
              setSidebarCollapsed(collapsed);
            }}
          >
            {mobile ? null : sidebar}
          </Panel>
          <ResizableDivider label="Resize navigation" />
          <Panel id="product-content" minSize="50%">
            <main className="product-shell-content">
              {mobile || sidebarCollapsed ? (
                mobile ? (
                  <Dialog.Trigger
                    render={
                      <Button
                        ref={mobileSidebarTriggerRef}
                        className="product-sidebar-trigger sidebar-panel-control"
                        data-command-action="toggle-sidebar"
                        aria-label="Open sidebar"
                        title="Open sidebar"
                        variant="ghost"
                        size="icon-xs"
                      />
                    }
                  >
                    <SidebarPanelIcon />
                  </Dialog.Trigger>
                ) : (
                  <Button
                    className="product-sidebar-trigger sidebar-panel-control"
                    data-command-action="toggle-sidebar"
                    aria-label="Open sidebar"
                    title="Open sidebar"
                    variant="ghost"
                    size="icon-xs"
                    onClick={toggleSidebar}
                  >
                    <SidebarPanelIcon />
                  </Button>
                )
              ) : null}
              <Outlet />
            </main>
          </Panel>
        </Group>
      </Dialog.Root>
      <ThreadSearchDialog
        open={threadSearchOpen}
        userId={identity.id}
        finalFocus={mobile ? mobileSidebarTriggerRef : sidebarSearchTriggerRef}
        onOpenChange={setThreadSearchOpen}
        onSelectThread={selectSearchedThread}
      />
    </AppFrame>
  );
}
