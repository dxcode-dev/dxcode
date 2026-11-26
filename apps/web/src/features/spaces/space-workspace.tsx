import type {
  SpaceData,
  SpacePageLayout,
  SpaceThreadItem,
  ThreadDetailData,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { useQuery } from "@tanstack/react-query";
import {
  Navigate,
  useLocation,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../shared/auth/auth-context.js";
import { DxLoading } from "../../shared/brand/dx-loading.js";
import type {
  ComposerSlot,
  MessageFilesSlot,
} from "../../shared/composer/composer-slot.js";
import type { DictationSlot } from "../../shared/dictation/dictation-slot.js";
import { useOptionalThreadArchive } from "../../shared/thread-archive.js";
import type { ThreadAutomationsSlot } from "../../shared/thread-automations-slot.js";
import { Button } from "../../shared/ui/button.js";
import { DrawerContent, DrawerRoot } from "../../shared/ui/drawer.js";
import { DeleteSpaceDialog } from "./delete-space-dialog.js";
import { EditSpaceDialog } from "./edit-space-dialog.js";
import { SpacePostFilesContext } from "./posts/space-post-files-context.js";
import { SPACE_ARTIFACT_SHEET } from "./space-artifact.js";
import { SpaceAutomationsContext } from "./space-automations-context.js";
import { type RenderSpaceComments, SpaceChat } from "./space-chat.js";
import { useSpaceDetailsHidden } from "./space-details-store.js";
import { threadSelectionChip } from "./space-format.js";
import { type SpacePageChange, useSpacePageLayout } from "./space-layout.js";
import { SpacePanel } from "./space-panel.js";
import {
  spaceQueryOptions,
  spaceThreadsQueryOptions,
} from "./space-queries.js";
import {
  type ThreadTabThread,
  threadTabOfItem,
  threadTabOfThread,
} from "./space-tab-threads.js";
import {
  SpaceChatTab,
  SpaceStripTools,
  SpaceTabStrip,
  ThreadTab,
  ThreadTabTools,
} from "./space-tabs.js";
import {
  SpaceThreadsContext,
  threadIdOfHref,
  useCloseSpaceThread,
  useOpenSpaceThread,
} from "./use-open-space-thread.js";
import "./spaces.css";

const noFiles = () => null;
/** Posts show only their words without the transcript's file views. */
const NO_FILES: MessageFilesSlot = { Images: noFiles, Links: noFiles };
const NO_AUTOMATIONS: ThreadAutomationsSlot = {
  Chips: noFiles,
  MenuItems: noFiles,
  Sheet: noFiles,
};

/** From this width Space Details is a column beside the panes. */
const DETAILS_COLUMN_QUERY = "(min-width: 1024px)";
/** From this width an open thread sits beside the Space chat. */
const SPLIT_QUERY = "(min-width: 1280px)";
/** A phone: the strip keeps only Show Space Details. */
const PHONE_QUERY = "(max-width: 767px)";

const useMediaQuery = (query: string) => {
  const list = window.matchMedia(query);
  const subscribe = (notify: () => void) => {
    list.addEventListener("change", notify);
    return () => list.removeEventListener("change", notify);
  };
  const snapshot = () => list.matches;
  return React.useSyncExternalStore(subscribe, snapshot, snapshot);
};

/**
 * What the Thread page hands the tab strip that stands for its title bar:
 * the Thread and its More Actions.
 */
export interface SpaceTitleBarParts {
  readonly thread: ThreadDetailData;
  readonly menu: () => React.ReactNode;
  readonly views: React.ReactNode;
  readonly stacked: boolean;
}

/** What a Space asks of the Thread page it renders in a thread's tab. */
export interface SpaceThreadSlots {
  /** The thread the tab shows. */
  readonly threadId: ThreadId;
  /** The tab strip in place of the Thread's title bar. */
  readonly renderTitleBar: (parts: SpaceTitleBarParts) => React.ReactNode;
  /**
   * The page while the thread loads or cannot open: the tab strip, from
   * the Space's list of its threads, over that state.
   */
  readonly renderPending: (state: React.ReactNode) => React.ReactNode;
}

/**
 * Space Details as a bottom sheet over the page. Dragging it down, tapping
 * its handle or the page behind it, or Escape closes it.
 */
function SpaceDetailsSheet({
  open,
  onOpenChange,
  children,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly children: React.ReactNode;
}) {
  return (
    <DrawerRoot open={open} onOpenChange={onOpenChange} swipeDirection="down">
      <DrawerContent
        className="space-sheet"
        layer="panel"
        aria-label="Space Details"
        handleLabel="Close Space Details"
      >
        {children}
      </DrawerContent>
    </DrawerRoot>
  );
}

/** The page's view of one of the Space's own artifacts, full screen. */
export type SpaceArtifactSlot = React.ComponentType<{
  readonly threadId: ThreadId;
  readonly readOnly: boolean;
  readonly dictation: DictationSlot | undefined;
}>;

/** Whether the URL asks for one of the Space's own artifacts, full screen. */
const useSpaceArtifactRequested = () =>
  useLocation({
    select: (location) =>
      location.search?.sheet === SPACE_ARTIFACT_SHEET &&
      typeof location.search?.artifact === "string",
  });

/**
 * Opens a link to one of the Space's threads in a tab instead of leaving
 * the Space, for links anywhere in the chat or an open thread.
 */
const useChildLinkCapture = (childThreadIds: ReadonlySet<string>) => {
  const open = useOpenSpaceThread();
  return (event: React.MouseEvent<HTMLElement>) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    const anchor =
      event.target instanceof Element
        ? event.target.closest<HTMLAnchorElement>("a[href]")
        : null;
    if (anchor === null || (anchor.target !== "" && anchor.target !== "_self"))
      return;
    const threadId = threadIdOfHref(anchor.href);
    if (threadId === undefined || !childThreadIds.has(threadId)) return;
    if (!open(threadId)) return;
    event.preventDefault();
    event.stopPropagation();
  };
};

type SpaceDialog = "edit" | "delete";

function SpacePage({
  space,
  threads,
  childThreadId,
  layout,
  onChange,
  renderThread,
  renderComments,
  Artifact,
  dictation,
  Composer,
}: {
  readonly space: SpaceData;
  readonly threads: ReadonlyArray<SpaceThreadItem> | undefined;
  readonly childThreadId: ThreadId | undefined;
  /** How the person left the page: Side by Side, the front tab, Details. */
  readonly layout: SpacePageLayout;
  readonly onChange: (change: SpacePageChange) => void;
  readonly renderThread: (slots: SpaceThreadSlots) => React.ReactNode;
  readonly renderComments?: RenderSpaceComments;
  readonly Artifact?: SpaceArtifactSlot;
  readonly dictation?: DictationSlot;
  readonly Composer: ComposerSlot;
}) {
  const { identity } = useAuthenticatedIdentity();
  const artifactRequested = useSpaceArtifactRequested();
  const detailsColumnFits = useMediaQuery(DETAILS_COLUMN_QUERY);
  const splitFits = useMediaQuery(SPLIT_QUERY);
  const phone = useMediaQuery(PHONE_QUERY);
  const [detailsHidden, setDetailsHidden] = useSpaceDetailsHidden(identity.id);
  const [sheetOpen, setSheetOpen] = React.useState(false);
  const [dialog, setDialog] = React.useState<SpaceDialog>();
  const archive = useOptionalThreadArchive();
  const navigate = useNavigate();
  const { Chips } = React.use(SpaceAutomationsContext);
  const open = useOpenSpaceThread();
  const close = useCloseSpaceThread();
  const childIds = new Set((threads ?? []).map(({ id }) => id as string));
  const captureChildLinks = useChildLinkCapture(childIds);
  const child = childThreadId;
  // With the thread's tab beside it in one strip, the chat shows when the
  // person chose it for this thread.
  const spaceTabActive =
    child !== undefined && layout.front === "space" && layout.thread === child;
  const onSelectSpaceTab = () => onChange({ thread: child, front: "space" });
  const onSelectThreadTab = () => onChange({ thread: child, front: "thread" });
  const split = child !== undefined && splitFits && !layout.tabs;
  const column = detailsColumnFits && !detailsHidden;
  const showSpace = child === undefined || split || spaceTabActive;
  const showThread = child !== undefined && (split || !spaceTabActive);
  const own = space.access === "owner";
  const archived = space.lifecycleState === "archived";
  const editable = own && !archived;
  const onEdit = editable ? () => setDialog("edit") : undefined;
  const onDelete = own ? () => setDialog("delete") : undefined;
  const onArchive =
    own && !archived && archive !== undefined
      ? () => archive.setArchived(space.threadId, true)
      : undefined;
  const onUnarchive =
    own && archive !== undefined
      ? () => archive.setArchived(space.threadId, false)
      : undefined;
  const unarchiving =
    archive?.pendingThreadId === space.threadId &&
    archive.pendingArchived === false;
  const openThread = (threadId: ThreadId) => {
    setSheetOpen(false);
    open(threadId);
  };
  const closeSheet = () => setSheetOpen(false);
  // A message's comments open over the Space chat, so it comes to the front
  // when a thread's tab shares its strip.
  const showChat = () => {
    if (child !== undefined && !split) onSelectSpaceTab();
  };
  const showDetails = () => {
    if (detailsColumnFits) setDetailsHidden(false);
    else setSheetOpen(true);
  };
  const item = threads?.find(({ id }) => id === child);
  const toggleSplit = splitFits
    ? () => onChange({ tabs: !layout.tabs })
    : undefined;
  // The Space chat's strip ends with Space Details' quick parts while the
  // column is not shown, unless the thread's own strip ends the row.
  const stripTools = (menu: boolean) =>
    column ? null : (
      <SpaceStripTools
        space={space}
        userId={identity.id}
        compact={phone}
        menu={menu}
        onEdit={onEdit}
        onDelete={onDelete}
        onArchive={onArchive}
        onShow={showDetails}
      />
    );
  // The open thread's strip: the Space chat's tab where they share one, the
  // thread's tab, and its tools.
  const threadStrip = (
    threadId: ThreadId,
    parts: {
      readonly tab: ThreadTabThread;
      readonly menu?: React.ReactNode;
      readonly automations?: React.ReactNode;
      readonly views: React.ReactNode;
      readonly mode: React.ComponentProps<typeof ThreadTabTools>["mode"];
    },
  ) => (
    <SpaceTabStrip label={split ? "Thread tab" : "Tabs"}>
      {split ? null : (
        <SpaceChatTab
          space={space}
          active={false}
          onSelect={onSelectSpaceTab}
        />
      )}
      <ThreadTab thread={parts.tab} active menu={parts.menu} onClose={close} />
      <span className="space-tab-spacer" />
      <ThreadTabTools
        threadId={threadId}
        automations={parts.automations}
        views={parts.views}
        mode={parts.mode}
        split={split}
        onToggleSplit={toggleSplit}
      />
      {split ? null : stripTools(false)}
    </SpaceTabStrip>
  );
  const threadTabInSpaceStrip =
    child !== undefined && !split ? (
      <ThreadTab
        thread={threadTabOfItem(child, item)}
        active={false}
        onSelect={onSelectThreadTab}
        onClose={close}
      />
    ) : null;
  return (
    <div
      className="space-page"
      data-details={column ? "column" : undefined}
      data-split={split ? "" : undefined}
      data-phone={phone ? "" : undefined}
      {...{ "data-thread-color": space.color }}
    >
      <div
        className="space-panes"
        onClickCapture={captureChildLinks}
        role="presentation"
      >
        <section
          className="space-pane space-chat-pane"
          aria-label={`${space.name} chat`}
          hidden={!showSpace}
        >
          <SpaceTabStrip label="Tabs">
            <SpaceChatTab space={space} active />
            {threadTabInSpaceStrip}
            <span className="space-tab-spacer" />
            {/* A phone keeps Space Actions in the chat's strip, as a
                Thread keeps More Actions in its bar. */}
            {stripTools(true)}
          </SpaceTabStrip>
          <div className="space-pane-body">
            <SpaceChat
              space={space}
              Composer={Composer}
              renderComments={renderComments}
              onUnarchive={onUnarchive}
              unarchiving={unarchiving}
            />
          </div>
        </section>
        {child === undefined ? null : (
          <section
            className="space-pane space-thread-pane"
            aria-label={item?.title ?? "Thread"}
            hidden={!showThread}
          >
            {renderThread({
              threadId: child,
              renderTitleBar: (parts) =>
                threadStrip(child, {
                  tab: threadTabOfThread(parts.thread),
                  menu: parts.menu(),
                  automations:
                    phone ||
                    (parts.thread.access !== undefined &&
                      parts.thread.access !== "owner") ? null : (
                      <Chips threadId={child} />
                    ),
                  views: parts.views,
                  mode: threadSelectionChip(
                    parts.thread.agentInitialization.selection,
                  ),
                }),
              // The tabs stay while the thread loads, so opening another
              // thread changes its tab, not the whole Space.
              renderPending: (state) => (
                <div className="space-thread-pending">
                  {threadStrip(child, {
                    tab: threadTabOfItem(child, item),
                    views: null,
                    mode: undefined,
                  })}
                  <div className="space-pane-body">{state}</div>
                </div>
              ),
            })}
          </section>
        )}
      </div>
      {column ? (
        <aside className="space-details-column" aria-label="Space Details">
          <SpacePanel
            space={space}
            activeThreadId={child}
            tab={layout.details}
            onTabChange={(details) => onChange({ details })}
            onOpenThread={openThread}
            onOpenComments={showChat}
            onEdit={onEdit}
            onDelete={onDelete}
            onArchive={onArchive}
            onHide={() => setDetailsHidden(true)}
          />
        </aside>
      ) : null}
      {detailsColumnFits ? null : (
        <SpaceDetailsSheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SpacePanel
            space={space}
            activeThreadId={child}
            onOpenThread={openThread}
            onOpenComments={showChat}
            onOpened={closeSheet}
            onEdit={onEdit}
            onDelete={onDelete}
            onArchive={onArchive}
          />
        </SpaceDetailsSheet>
      )}
      {artifactRequested && Artifact !== undefined ? (
        <Artifact
          threadId={space.threadId}
          readOnly={space.access === "view" || archived}
          dictation={dictation}
        />
      ) : null}
      {dialog === "edit" ? (
        <EditSpaceDialog
          space={space}
          userId={identity.id}
          dictation={dictation}
          onClose={() => setDialog(undefined)}
        />
      ) : null}
      {dialog === "delete" ? (
        <DeleteSpaceDialog
          space={space}
          onClose={() => setDialog(undefined)}
          onDeleted={() => void navigate({ to: "/" })}
        />
      ) : null}
    </div>
  );
}

/**
 * A Space's page: a tab strip whose first tab is the Space chat (its posts
 * and composer), any thread it started open as a further tab
 * (`?thread=`), beside the chat on a wide page, and Space Details on the
 * right.
 */
export function SpaceWorkspace({
  renderThread,
  renderComments,
  Artifact,
  dictation,
  Composer,
  files,
  automations,
}: {
  readonly renderThread: (slots: SpaceThreadSlots) => React.ReactNode;
  readonly renderComments?: RenderSpaceComments;
  /** One of the Space's own artifacts, full screen over the page. */
  readonly Artifact?: SpaceArtifactSlot;
  readonly dictation?: DictationSlot;
  /** The Thread composer's box for the Space's chat. */
  readonly Composer: ComposerSlot;
  /** The transcript's file views, for posts' files. */
  readonly files?: MessageFilesSlot;
  /** A Thread title bar's issues, pull requests, CI, and listeners. */
  readonly automations?: ThreadAutomationsSlot;
}) {
  const { threadId } = useParams({ from: "/_product/threads/$threadId" });
  const { identity } = useAuthenticatedIdentity();
  const spaceThreadId = threadId as ThreadId;
  const spaceQuery = useQuery(spaceQueryOptions(identity.id, spaceThreadId));
  const space = spaceQuery.data;
  const threadsQuery = useQuery(
    spaceThreadsQueryOptions(identity.id, spaceThreadId),
  );
  const threads = threadsQuery.data;
  // The page's own URL, not the router's location: while the next page
  // loads, the location is already the next page's, which names no thread,
  // and reading it would restore the saved thread and navigate back here.
  const requested = useSearch({
    from: "/_product/threads/$threadId",
    select: (search) => search.thread as ThreadId | undefined,
  });
  // Still on this Space's URL, not leaving it for another page.
  const here = useLocation({
    select: (location) => location.pathname === `/threads/${spaceThreadId}`,
  });
  const { layout, change } = useSpacePageLayout(spaceThreadId);
  const childThreadIds = new Set((threads ?? []).map(({ id }) => id as string));
  // Opened without a thread (the sidebar, a reload of the bare Space, another
  // device), the Space brings back the thread the person left open, while
  // it is still one of the Space's.
  const saved = requested === undefined ? layout?.thread : undefined;
  const restoring =
    saved !== undefined && threads === undefined && !threadsQuery.isError;
  const restored =
    saved !== undefined && childThreadIds.has(saved) ? saved : undefined;
  const opened = requested ?? restored;
  const childThreadId = opened === spaceThreadId ? undefined : opened;
  // Not found says so at once, as a Thread that does not exist does.
  if (space === undefined && spaceQuery.isError)
    return (
      <div className="fatal-state">
        <strong>Space unavailable</strong>
        <span>
          {spaceQuery.error instanceof Error && spaceQuery.error.message !== ""
            ? spaceQuery.error.message
            : "The Space could not load."}
        </span>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void spaceQuery.refetch()}
        >
          Retry
        </Button>
      </div>
    );
  // The page waits for its saved layout, so it opens as the person left it
  // instead of changing under them.
  if (space === undefined || layout === undefined || restoring)
    return <DxLoading label="Loading Space…" variant="pane" />;
  return (
    <SpacePostFilesContext value={files ?? NO_FILES}>
      <SpaceAutomationsContext value={automations ?? NO_AUTOMATIONS}>
        <SpaceThreadsContext
          value={{
            spaceThreadId,
            childThreadIds,
            reveal: (thread) => change({ thread, front: "thread" }),
            forget: () => change({ thread: null }),
          }}
        >
          {restored === undefined || !here ? null : (
            // The URL names the thread again, as opening it does.
            <Navigate
              to="/threads/$threadId"
              params={{ threadId: spaceThreadId }}
              search={(previous: Record<string, unknown>) => ({
                ...previous,
                thread: restored,
              })}
              replace
            />
          )}
          <SpacePage
            space={space}
            threads={threads}
            childThreadId={childThreadId}
            layout={layout}
            onChange={change}
            renderThread={renderThread}
            renderComments={renderComments}
            Artifact={Artifact}
            dictation={dictation}
            Composer={Composer}
          />
        </SpaceThreadsContext>
      </SpaceAutomationsContext>
    </SpacePostFilesContext>
  );
}
