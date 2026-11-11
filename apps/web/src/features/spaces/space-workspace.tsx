import { Drawer } from "@base-ui/react/drawer";
import type { SpaceData, SpaceThreadItem, ThreadDetailData } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../shared/auth/auth-context.js";
import { DxLoading } from "../../shared/brand/dx-loading.js";
import type {
  ComposerSlot,
  MessageFilesSlot,
} from "../../shared/composer/composer-slot.js";
import type { DictationSlot } from "../../shared/dictation/dictation-slot.js";
import { useOptionalThreadArchive } from "../../shared/thread-archive.js";
import { Button } from "../../shared/ui/button.js";
import { ConfirmDialog } from "../../shared/ui/confirm-dialog.js";
import { deleteThreadMutationOptions } from "../threads/thread-mutations.js";
import { EditSpaceDialog } from "./edit-space-dialog.js";
import { SpacePostFilesContext } from "./posts/space-post-files-context.js";
import { SPACE_ARTIFACT_SHEET } from "./space-artifact.js";
import { type RenderSpaceComments, SpaceChat } from "./space-chat.js";
import { useSpaceDetailsHidden } from "./space-details-store.js";
import { threadSelectionChip } from "./space-format.js";
import { SpacePanel } from "./space-panel.js";
import {
  spaceQueryOptions,
  spaceThreadsQueryOptions,
} from "./space-queries.js";
import { threadTabOfItem, threadTabOfThread } from "./space-tab-threads.js";
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
    <Drawer.Root open={open} onOpenChange={onOpenChange} swipeDirection="down">
      <Drawer.Portal>
        <Drawer.Backdrop className="space-sheet-backdrop" />
        <Drawer.Viewport className="space-sheet-viewport">
          <Drawer.Popup className="space-sheet" aria-label="Space Details">
            <Drawer.Close
              className="space-sheet-handle"
              aria-label="Close Space Details"
            >
              <span />
            </Drawer.Close>
            <Drawer.Content className="space-sheet-content">
              {children}
            </Drawer.Content>
          </Drawer.Popup>
        </Drawer.Viewport>
      </Drawer.Portal>
    </Drawer.Root>
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

/** Deletes the Space after asking; its page goes home once it is gone. */
function DeleteSpaceDialog({
  space,
  onClose,
}: {
  readonly space: SpaceData;
  readonly onClose: () => void;
}) {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const remove = useMutation(
    deleteThreadMutationOptions(queryClient, identity.id),
  );
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title="Delete Space?"
      description={
        <>
          &ldquo;{space.name}&rdquo; and its chat will be permanently deleted.
          The threads it started stay in your sidebar.
        </>
      }
      error={
        remove.error === null
          ? undefined
          : remove.error instanceof Error && remove.error.message !== ""
            ? remove.error.message
            : "The Space could not be deleted."
      }
      confirmLabel={remove.isPending ? "Deleting…" : "Delete"}
      destructive
      pending={remove.isPending}
      onConfirm={() =>
        remove.mutate(
          { threadId: space.threadId },
          {
            onSuccess: () => {
              onClose();
              void navigate({ to: "/" });
            },
          },
        )
      }
    />
  );
}

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
  spaceTabActive,
  onSelectSpaceTab,
  onSelectThreadTab,
  renderThread,
  renderComments,
  Artifact,
  dictation,
  Composer,
}: {
  readonly space: SpaceData;
  readonly threads: ReadonlyArray<SpaceThreadItem> | undefined;
  readonly childThreadId: ThreadId | undefined;
  /** With the thread's tab beside it in one strip, the chat shows. */
  readonly spaceTabActive: boolean;
  readonly onSelectSpaceTab: () => void;
  readonly onSelectThreadTab: () => void;
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
  const [tabbed, setTabbed] = React.useState(false);
  const [dialog, setDialog] = React.useState<SpaceDialog>();
  const archive = useOptionalThreadArchive();
  const open = useOpenSpaceThread();
  const close = useCloseSpaceThread();
  const childIds = new Set((threads ?? []).map(({ id }) => id as string));
  const captureChildLinks = useChildLinkCapture(childIds);
  const child = childThreadId;
  const split = child !== undefined && splitFits && !tabbed;
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
  const toggleSplit = splitFits ? () => setTabbed((now) => !now) : undefined;
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
              renderTitleBar: (parts) => (
                <SpaceTabStrip label={split ? "Thread tab" : "Tabs"}>
                  {split ? null : (
                    <SpaceChatTab
                      space={space}
                      active={false}
                      onSelect={onSelectSpaceTab}
                    />
                  )}
                  <ThreadTab
                    thread={threadTabOfThread(parts.thread)}
                    active
                    menu={parts.menu()}
                    onClose={close}
                  />
                  <span className="space-tab-spacer" />
                  <ThreadTabTools
                    threadId={child}
                    views={parts.views}
                    mode={threadSelectionChip(
                      parts.thread.agentInitialization.selection,
                    )}
                    split={split}
                    onToggleSplit={toggleSplit}
                  />
                  {split ? null : stripTools(false)}
                </SpaceTabStrip>
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
        <DeleteSpaceDialog space={space} onClose={() => setDialog(undefined)} />
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
}) {
  const { threadId } = useParams({ from: "/_product/threads/$threadId" });
  const { identity } = useAuthenticatedIdentity();
  const spaceThreadId = threadId as ThreadId;
  const spaceQuery = useQuery(spaceQueryOptions(identity.id, spaceThreadId));
  const space = spaceQuery.data;
  const threads = useQuery(
    spaceThreadsQueryOptions(identity.id, spaceThreadId),
  ).data;
  const requested = useLocation({
    select: (location) => {
      const thread: unknown = location.search?.thread;
      return typeof thread === "string" ? (thread as ThreadId) : undefined;
    },
  });
  const childThreadId = requested === spaceThreadId ? undefined : requested;
  // Which tab shows while the thread's tab shares the Space chat's strip:
  // the thread when it was just opened, until the Space tab is chosen.
  const [spaceTabFor, setSpaceTabFor] = React.useState<ThreadId>();
  const childThreadIds = new Set((threads ?? []).map(({ id }) => id as string));
  // Not found (or Spaces switched off for this person) says so at once,
  // as a Thread that does not exist does.
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
  if (space === undefined)
    return <DxLoading label="Loading Space…" variant="pane" />;
  return (
    <SpacePostFilesContext value={files ?? NO_FILES}>
      <SpaceThreadsContext
        value={{
          spaceThreadId,
          childThreadIds,
          reveal: () => setSpaceTabFor(undefined),
        }}
      >
        <SpacePage
          space={space}
          threads={threads}
          childThreadId={childThreadId}
          spaceTabActive={
            childThreadId !== undefined && spaceTabFor === childThreadId
          }
          onSelectSpaceTab={() => setSpaceTabFor(childThreadId)}
          onSelectThreadTab={() => setSpaceTabFor(undefined)}
          renderThread={renderThread}
          renderComments={renderComments}
          Artifact={Artifact}
          dictation={dictation}
          Composer={Composer}
        />
      </SpaceThreadsContext>
    </SpacePostFilesContext>
  );
}
