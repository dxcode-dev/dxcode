import { Dialog } from "@base-ui/react/dialog";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Outlet, useLocation, useNavigate } from "@tanstack/react-router";
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
import { setThreadPinnedMutationOptions } from "../threads/thread-mutations.js";
import { threadsQueryOptions } from "../threads/thread-queries.js";
import { AppSidebar } from "./app-sidebar.js";
import { shouldOpenMobileSidebarByDefault } from "./mobile-sidebar.js";
import { SidebarExtensionRegion } from "./sidebar-extensions.js";
import { SidebarPanelIcon } from "./sidebar-panel-icon.js";
import { ThreadSearchDialog } from "./thread-search-dialog.js";

export const PRODUCT_SIDEBAR_MIN_SIZE = 250;
export const PRODUCT_SIDEBAR_MAX_SIZE = 480;

export function ProductShell() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const navigate = useNavigate();
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const pinMutation = useMutation(
    setThreadPinnedMutationOptions(queryClient, identity.id),
  );
  const projectsQuery = useInfiniteQuery(projectsQueryOptions(identity.id));
  const threadsQuery = useInfiniteQuery(
    threadsQueryOptions(identity.id, undefined, "active"),
  );
  const personalAccountQuery = useQuery(
    personalAccountQueryOptions(identity.id),
  );
  const settingsQuery = useQuery(settingsContextQueryOptions(identity.id));
  const projects =
    projectsQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const threads = threadsQuery.data?.pages.flatMap((page) => page.items) ?? [];
  // An empty active list can still have archived Threads. Reuse the archive
  // cache so checking availability does not hide the only path to those rows.
  const checkEmptyArchive = threadsQuery.isSuccess && threads.length === 0;
  const archiveQuery = useInfiniteQuery({
    ...threadsQueryOptions(identity.id, undefined, "archived"),
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
  const [mobileSidebarOpen, setMobileSidebarOpen] = React.useState(() =>
    shouldOpenMobileSidebarByDefault(mobile, pathname),
  );
  const [threadSearchOpen, setThreadSearchOpen] = React.useState(false);
  const searchQuery = useInfiniteQuery({
    ...threadsQueryOptions(identity.id),
    enabled: threadSearchOpen,
  });
  const sidebarSearchTriggerRef = React.useRef<HTMLButtonElement>(null);
  const mobileSidebarTriggerRef = React.useRef<HTMLButtonElement>(null);
  const mobileSidebarPopupRef = React.useRef<HTMLDivElement>(null);

  const toggleSidebar = React.useCallback(() => {
    if (mobile) setMobileSidebarOpen((open) => !open);
    else {
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
  }, [mobile, sidebarCollapsed, sidebarRef]);

  const sidebar = (
    <AppSidebar
      userId={identity.id}
      archiveAvailable={archiveAvailable}
      projects={projects}
      threads={threads}
      personalAccount={personalAccountQuery.data}
      settingsContext={settingsQuery.data}
      onCollapse={toggleSidebar}
      collapseLabel={mobile ? "Close sidebar" : "Collapse sidebar"}
      onNavigate={() => setMobileSidebarOpen(false)}
      onOpenSearch={() => setThreadSearchOpen(true)}
      searchTriggerRef={sidebarSearchTriggerRef}
      onLoadMore={() => void threadsQuery.fetchNextPage()}
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
      onSetPinned={(threadId, pinned) =>
        pinMutation.mutate({ threadId, pinned })
      }
      pinningThreadId={
        pinMutation.isPending ? pinMutation.variables.threadId : undefined
      }
      extensionRegion={<SidebarExtensionRegion />}
    />
  );

  return (
    <AppFrame className="product-shell">
      <Dialog.Root
        open={mobile && mobileSidebarOpen}
        onOpenChange={setMobileSidebarOpen}
      >
        <Dialog.Portal>
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
        projects={projects}
        threads={
          searchQuery.data?.pages.flatMap((page) => page.items) ?? threads
        }
        hasMore={searchQuery.hasNextPage}
        loading={searchQuery.isPending || searchQuery.isFetchingNextPage}
        onLoadMore={() => void searchQuery.fetchNextPage()}
        error={
          searchQuery.error instanceof Error
            ? searchQuery.error.message
            : undefined
        }
        finalFocus={mobile ? mobileSidebarTriggerRef : sidebarSearchTriggerRef}
        onOpenChange={setThreadSearchOpen}
        onSelectThread={(thread) => {
          setMobileSidebarOpen(false);
          void navigate({
            to: "/threads/$threadId",
            params: { threadId: thread.id },
          });
        }}
      />
    </AppFrame>
  );
}
