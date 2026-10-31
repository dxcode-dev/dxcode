import { Dialog } from "@base-ui/react/dialog";
import { SIDEBAR_WIDTH_MAX_PX, SIDEBAR_WIDTH_MIN_PX } from "@dx/api";
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
import { AppUpdateDot } from "../../shared/app-update/app-update-row.js";
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
import { sidebarDrawerDrag } from "./sidebar-drawer-drag.js";
import { SidebarExtensionRegion } from "./sidebar-extensions.js";
import { SidebarPanelIcon } from "./sidebar-panel-icon.js";
import { childThreadsByParent } from "./sidebar-thread-utils.js";
import { SIDEBAR_PANEL_ID, useSavedSidebarPanel } from "./sidebar-width.js";
import { ThreadSearchDialog } from "./thread-search-dialog.js";

const PRODUCT_SIDEBAR_MIN_SIZE = SIDEBAR_WIDTH_MIN_PX;
const PRODUCT_SIDEBAR_MAX_SIZE = SIDEBAR_WIDTH_MAX_PX;
const sidebarExtensionRegion = <SidebarExtensionRegion />;

/**
 * The signed-in layout. `notices` are full-width bars above the panels, such
 * as the new-version and install banners the application composes in.
 */
export function ProductShell({
  notices,
}: {
  readonly notices?: React.ReactNode;
}) {
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
  const mobile = useMobile();
  const sidebarPanel = useSavedSidebarPanel(identity.id, mobile);
  const [sidebarCollapsed, setSidebarCollapsed] = React.useState(
    sidebarPanel.startsCollapsed,
  );
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

  // On a phone the drawer drags like a native one: pulled out from the left
  // half of the page, pushed back from the drawer or its scrim.
  const openSidebar = () => setMobileSidebar(true);
  const closeSidebar = () => setMobileSidebarOpen(false);
  const keepSidebarMounted = () => setMobileSidebarKept(true);
  const pullSidebar = mobile
    ? sidebarDrawerDrag(true, openSidebar, closeSidebar, keepSidebarMounted)
    : undefined;
  const pushSidebar = sidebarDrawerDrag(false, openSidebar, closeSidebar);
  const attachMobileSidebarPopup = (node: HTMLDivElement | null) => {
    mobileSidebarPopupRef.current = node;
    const detach = pushSidebar(node);
    return () => {
      mobileSidebarPopupRef.current = null;
      detach?.();
    };
  };

  // A collapsed sidebar is inert, so focus inside it would fall to the page
  // body. Collapsing from inside the sidebar focuses the open button, and
  // opening from that button focuses the sidebar's own toggle.
  const focusOpenTriggerRef = React.useRef(false);
  const attachOpenTrigger = (node: HTMLButtonElement) => {
    if (focusOpenTriggerRef.current) {
      focusOpenTriggerRef.current = false;
      node.focus();
    }
    return () => {
      if (document.activeElement !== node) return;
      // Runs after the commit that removes `inert` from the sidebar.
      queueMicrotask(() =>
        document
          .querySelector<HTMLElement>(
            ".product-navigation-panel [data-command-action='toggle-sidebar']",
          )
          ?.focus(),
      );
    };
  };

  const toggleSidebar = () => {
    if (mobile) {
      setMobileSidebarOpen((open) => !open);
      setMobileSidebarKept(true);
    } else {
      const panel = document.querySelector<HTMLElement>(
        ".product-panel-group > :first-child",
      );
      if (sidebarCollapsed) {
        // Drop `inert` now rather than at the panel's next resize report, so
        // a caller can focus a sidebar row on the next frame.
        setSidebarCollapsed(false);
        // A sidebar that loaded collapsed has no earlier size to expand to,
        // so it opens at its saved width.
        expandResizablePanel(panel, sidebarPanel.expandedGrow(), () => {
          sidebarRef.current?.expand();
          sidebarRef.current?.resize(`${sidebarPanel.width()}px`);
        });
      } else {
        focusOpenTriggerRef.current =
          panel?.contains(document.activeElement) === true;
        const currentGrow =
          panel === null ? "1" : getComputedStyle(panel).flexGrow;
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
      {notices}
      <Dialog.Root
        open={mobile && mobileSidebarOpen}
        onOpenChange={setMobileSidebar}
      >
        <Dialog.Portal keepMounted={mobile && mobileSidebarKept}>
          <Dialog.Backdrop className="mobile-sidebar-scrim" ref={pushSidebar} />
          <Dialog.Popup
            ref={attachMobileSidebarPopup}
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
          elementRef={sidebarPanel.groupRef}
          onLayoutChanged={sidebarPanel.onLayoutChanged}
        >
          <Panel
            id={SIDEBAR_PANEL_ID}
            className="product-navigation-panel"
            hidden={mobile}
            groupResizeBehavior="preserve-pixel-size"
            panelRef={sidebarRef}
            defaultSize={sidebarPanel.defaultSize}
            minSize={`${PRODUCT_SIDEBAR_MIN_SIZE}px`}
            maxSize={`${PRODUCT_SIDEBAR_MAX_SIZE}px`}
            collapsible
            collapsedSize="0px"
            inert={sidebarCollapsed}
            onResize={(size) => {
              const collapsed = size.asPercentage === 0;
              setSidebarCollapsed(collapsed);
              sidebarPanel.onCollapsedChange(collapsed);
            }}
          >
            {mobile ? null : sidebar}
          </Panel>
          <ResizableDivider label="Resize navigation" />
          <Panel id="product-content" minSize="50%">
            <main className="product-shell-content" ref={pullSidebar}>
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
                    <AppUpdateDot />
                  </Dialog.Trigger>
                ) : (
                  <Button
                    ref={attachOpenTrigger}
                    className="product-sidebar-trigger sidebar-panel-control"
                    data-command-action="toggle-sidebar"
                    aria-label="Open sidebar"
                    title="Open sidebar"
                    variant="ghost"
                    size="icon-xs"
                    onClick={toggleSidebar}
                  >
                    <SidebarPanelIcon />
                    <AppUpdateDot />
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
