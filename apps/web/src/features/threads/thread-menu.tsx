import type { ProjectData, ThreadDetailData } from "@dx/api";
import { Link } from "@tanstack/react-router";
import { DateTime } from "effect";
import {
  AlarmClock,
  AlarmClockOff,
  Archive,
  ArchiveRestore,
  Braces,
  Bug,
  Check,
  Ellipsis,
  FileDown,
  FileText,
  Hash,
  Link2,
  Pencil,
  Pin,
  PinOff,
  Share2,
  Trash2,
} from "lucide-react";
import * as React from "react";
import {
  type CommandId,
  getBrowserCommandRegistry,
} from "../../shared/commands/command-registry.js";
import { ShortcutKeycaps } from "../../shared/commands/shortcut-keycaps.js";
import { useNowMinute } from "../../shared/hooks/use-clock.js";
import { useMountEffect } from "../../shared/hooks/use-mount-effect.js";
import { useOptionalThreadArchive } from "../../shared/thread-archive.js";
import { copyThreadId, copyThreadUrl } from "../../shared/thread-copy.js";
import {
  type ThreadEditingController,
  useOptionalThreadEditing,
} from "../../shared/thread-editing.js";
import {
  type ThreadSnoozeController,
  useOptionalThreadSnooze,
} from "../../shared/thread-snooze.js";
import { Button } from "../../shared/ui/button.js";
import {
  MenuItem,
  MenuPopup,
  MenuRoot,
  MenuSeparator,
  MenuSubmenuRoot,
  MenuSubmenuTrigger,
  MenuTrigger,
} from "../../shared/ui/menu.js";
import { SubthreadIcon } from "../../shared/ui/subthread-icon.js";
import { ThreadColorSubmenu } from "../../shared/ui/thread-color-submenu.js";
import { SnoozeMenuItems } from "../../shared/ui/thread-snooze-menu.js";
import type { DictationRecord } from "./dictation/dictation-session.js";
import { ThreadPresentationContext } from "./thread-session-context.js";
import type { TranscriptViewModel } from "./transcript-view-model.js";

// The Orb and cost rows read the Orb and usage once the menu opens, so their
// code stays out of the Thread page's first load. It loads once the page is
// idle, or sooner at the first sign of reaching for the menu (a pointer over
// or down on its button, or focus). Loaded, the rows render in the menu's
// first frame, so the menu never grows: loading on the tap itself left them
// 170-230 ms behind the menu on a phone at 4x CPU.
let loadedDetails: typeof import("./thread-menu-chunk.js") | undefined;
const loadDetails = () =>
  import("./thread-menu-chunk.js").then((module) => {
    loadedDetails = module;
    return module;
  });
const LazyDetails = React.lazy(loadDetails);
const preloadDetails = () => void loadDetails();

/** Loads the rows once the browser is idle; returns its cancellation. */
const preloadDetailsWhenIdle = () => {
  if (typeof window.requestIdleCallback === "function") {
    const id = window.requestIdleCallback(preloadDetails, { timeout: 4_000 });
    return () => window.cancelIdleCallback(id);
  }
  const timer = window.setTimeout(preloadDetails, 1_500);
  return () => window.clearTimeout(timer);
};

/** Report Bug, loaded when it first opens, as Settings loads it. */
const BugReportDialog = React.lazy(() =>
  import("./bug-reports/bug-report-dialog.js").then((module) => ({
    default: module.BugReportDialog,
  })),
);

/**
 * A Thread's Cost & Usage, loaded when it first opens. Reached through the
 * details chunk, which imports it, so the dialog's chunk list stays out of
 * the Thread page's first load.
 */
const ThreadUsageDialog = React.lazy(() =>
  loadDetails().then((module) => ({
    default: module.ThreadUsageDialogLoader,
  })),
);

function ThreadMenuDetails(props: React.ComponentProps<typeof LazyDetails>) {
  const Loaded = loadedDetails?.default;
  return Loaded === undefined ? (
    <React.Suspense fallback={null}>
      <LazyDetails {...props} />
    </React.Suspense>
  ) : (
    <Loaded {...props} />
  );
}

/** A Thread menu entry that opens a submenu of its own items. */
export function ThreadMenuSubmenu({
  icon,
  label,
  popupClassName,
  children,
}: {
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly popupClassName?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <MenuSubmenuRoot>
      <MenuSubmenuTrigger>
        {icon}
        <span>{label}</span>
      </MenuSubmenuTrigger>
      <MenuPopup
        className={`thread-actions-menu thread-actions-submenu ${popupClassName ?? ""}`}
        alignOffset={-4}
      >
        {children}
      </MenuPopup>
    </MenuSubmenuRoot>
  );
}

export function ThreadMenu({
  thread,
  project,
  transcript,
  onOpenShare,
  overflowItems,
  showDetails = false,
}: {
  readonly thread: ThreadDetailData;
  readonly project?: Pick<ProjectData, "name">;
  /** Reads the shown transcript when an export runs. */
  readonly transcript: () => TranscriptViewModel;
  /** Share, for a title bar with no room for its button. */
  readonly onOpenShare?: () => void;
  /**
   * Entries for the title bar controls a narrow bar took out of its row:
   * pull requests, CI, listeners, and the people in the Thread.
   */
  readonly overflowItems?: React.ReactNode;
  /**
   * Adds what the Thread runs on and its Project, which a phone's title bar
   * has no room for.
   */
  readonly showDetails?: boolean;
}) {
  useMountEffect(preloadDetailsWhenIdle);
  const archive = useOptionalThreadArchive();
  const editing = useOptionalThreadEditing();
  const snooze = useOptionalThreadSnooze();
  // Archiving and editing are the owner's; members of a shared Thread only
  // read or export.
  const own = thread.access === undefined || thread.access === "owner";
  const [announcement, setAnnouncement] = React.useState("");
  const retained = React.useContext(ThreadPresentationContext);
  const [reportingBug, setReportingBug] = React.useState<{
    readonly changesOpen: boolean;
    readonly dictation?: DictationRecord;
  }>();
  const [usageOpen, setUsageOpen] = React.useState(false);
  const openUsage = () => setUsageOpen(true);
  const copyUrlKeycaps = useCommandKeycaps("navigation.copy-url");
  const download = (format: "markdown" | "json") => {
    // The serializers come with the menu's details chunk, which loads when
    // the page is idle or the menu is reached for, so they stay out of the
    // Thread page's first load and are usually ready by the click.
    if (loadedDetails === undefined)
      void loadDetails().then(({ threadExport }) =>
        saveExport(threadExport, format),
      );
    else saveExport(loadedDetails.threadExport, format);
  };
  const saveExport = (
    {
      serializeThreadJson,
      serializeThreadMarkdown,
      threadExportFilename,
    }: typeof import("./thread-export.js"),
    format: "markdown" | "json",
  ) => {
    const markdown = format === "markdown";
    const model = transcript();
    const contents = markdown
      ? serializeThreadMarkdown({ thread, project, model })
      : serializeThreadJson({ thread, project, model });
    const url = URL.createObjectURL(
      new Blob([contents], {
        type: markdown
          ? "text/markdown;charset=utf-8"
          : "application/json;charset=utf-8",
      }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = threadExportFilename(
      thread.title,
      markdown ? "md" : "json",
    );
    anchor.click();
    URL.revokeObjectURL(url);
    setAnnouncement(`${markdown ? "Markdown" : "JSON"} export downloaded.`);
  };
  const editable = own && editing !== undefined;
  const pinnable = editable && thread.lifecycleState === "active";
  const snoozable =
    editable &&
    thread.lifecycleState === "active" &&
    thread.parentThreadId === undefined &&
    snooze !== undefined;
  return (
    <>
      <MenuRoot>
        <MenuTrigger
          onPointerEnter={preloadDetails}
          onPointerDown={preloadDetails}
          onFocus={preloadDetails}
          render={
            <Button
              className="thread-title-action"
              aria-label="More Actions"
              title="More Actions"
              variant="subtle"
              size="icon-xs"
            />
          }
        >
          <Ellipsis />
        </MenuTrigger>
        <MenuPopup align="start" className="thread-actions-menu">
          {/* A family shares as one unit, so members reach the Thread
                  that started this one too: its starter, or for a Thread
                  started before dx recorded starters, the family's root. */}
          {thread.parentThreadId === undefined ? null : (
            <MenuItem
              render={
                <Link
                  to="/threads/$threadId"
                  params={{
                    threadId: thread.startedByThreadId ?? thread.parentThreadId,
                  }}
                />
              }
            >
              <SubthreadIcon strokeWidth={2} />
              <span>Open Source Thread</span>
            </MenuItem>
          )}
          {thread.parentThreadId === undefined ? null : <MenuSeparator />}
          <MenuItem onClick={() => void copyThreadUrl(thread.id)}>
            <Link2 />
            <span>Copy Thread URL</span>
            <ShortcutKeycaps keycaps={copyUrlKeycaps} emptyLabel="" />
          </MenuItem>
          <ThreadIdentityItems thread={thread} onDownload={download} />
          {showDetails ? null : (
            <ThreadMenuDetails thread={thread} onOpenUsage={openUsage} />
          )}
          {onOpenShare === undefined &&
          overflowItems === undefined &&
          !pinnable &&
          !snoozable ? null : (
            <MenuSeparator />
          )}
          {overflowItems}
          {onOpenShare === undefined ? null : (
            <MenuItem onClick={onOpenShare}>
              <Share2 />
              <span>Share…</span>
            </MenuItem>
          )}
          {pinnable ? (
            <PinMenuItem threadId={thread.id} editing={editing} />
          ) : null}
          {snoozable ? (
            <SnoozeMenuItem thread={thread} snooze={snooze} />
          ) : null}
          {own ? (
            <>
              <MenuSeparator />
              {/* A Thread kept from a deleted project stays archived. */}
              {thread.projectDeleted === true ? null : (
                <MenuItem
                  disabled={
                    archive === undefined ||
                    archive.pendingThreadId === thread.id
                  }
                  onClick={() =>
                    archive?.setArchived(
                      thread.id,
                      thread.lifecycleState !== "archived",
                    )
                  }
                >
                  {thread.lifecycleState === "archived" ? (
                    <ArchiveRestore />
                  ) : (
                    <Archive />
                  )}
                  <span>
                    {thread.lifecycleState === "archived"
                      ? "Unarchive"
                      : "Archive"}
                  </span>
                </MenuItem>
              )}
              {editable ? (
                <>
                  <MenuItem onClick={() => editing.openRename(thread)}>
                    <Pencil />
                    <span>Rename</span>
                  </MenuItem>
                  <ThreadColorSubmenu
                    thread={thread}
                    onSelect={(color) => editing.setColor(thread.id, color)}
                  />
                  <MenuSeparator />
                  <DeleteMenuItem thread={thread} editing={editing} />
                </>
              ) : null}
            </>
          ) : null}
          {/* A phone lists what the Thread runs on, its Orb, Project,
                  and cost before Report Bug, which stays last. */}
          {showDetails ? (
            <ThreadMenuDetails
              thread={thread}
              project={project}
              layout="phone"
              onOpenUsage={openUsage}
            />
          ) : null}
          <MenuSeparator />
          <MenuItem
            onClick={() => {
              const dictation = retained?.dictation.latest();
              setReportingBug({
                changesOpen:
                  document.querySelector(
                    `.changes-pane[data-thread-id="${thread.id}"]`,
                  ) !== null,
                ...(dictation === undefined ? {} : { dictation }),
              });
            }}
          >
            <Bug />
            <span>Report Bug</span>
          </MenuItem>
        </MenuPopup>
      </MenuRoot>
      {reportingBug === undefined ? null : (
        <React.Suspense fallback={null}>
          <BugReportDialog
            thread={thread}
            project={project}
            transcript={transcript}
            changesOpen={reportingBug.changesOpen}
            dictation={reportingBug.dictation}
            onClose={() => setReportingBug(undefined)}
          />
        </React.Suspense>
      )}
      {usageOpen ? (
        <React.Suspense fallback={null}>
          <ThreadUsageDialog
            thread={thread}
            onClose={() => setUsageOpen(false)}
          />
        </React.Suspense>
      ) : null}
      <span className="sr-only" aria-live="polite">
        {announcement}
        {announcement ? <Check /> : null}
      </span>
    </>
  );
}

/** The keycaps bound to a command, as the keymap shows them. */
const useCommandKeycaps = (id: CommandId) => {
  const registry = getBrowserCommandRegistry();
  React.useSyncExternalStore(
    registry.subscribe,
    registry.getSnapshot,
    registry.getServerSnapshot,
  );
  return (
    registry.getCommands("thread").find((command) => command.id === id)
      ?.displayedKeycaps ?? []
  );
};

/** Snooze, with its wake times, or Wake while the Thread is snoozed. */
function SnoozeMenuItem({
  thread,
  snooze,
}: {
  readonly thread: ThreadDetailData;
  readonly snooze: ThreadSnoozeController;
}) {
  const now = useNowMinute();
  const snoozed =
    thread.snoozedUntil !== undefined &&
    DateTime.toEpochMillis(thread.snoozedUntil) > now;
  if (snoozed)
    return (
      <MenuItem onClick={() => snooze.wake(thread.id)}>
        <AlarmClockOff />
        <span>Wake</span>
      </MenuItem>
    );
  return (
    <ThreadMenuSubmenu icon={<AlarmClock />} label="Snooze">
      <SnoozeMenuItems threadId={thread.id} snooze={snooze} />
    </ThreadMenuSubmenu>
  );
}

/** Pins the Thread to the top of its sidebar group, as its row's menu does. */
function PinMenuItem({
  threadId,
  editing,
}: {
  readonly threadId: ThreadDetailData["id"];
  readonly editing: ThreadEditingController;
}) {
  // Read as the menu opens, so it follows a pin made since the last open.
  const pinned = editing.pinned(threadId);
  return (
    <MenuItem onClick={() => editing.setPinned(threadId, !pinned)}>
      {pinned ? <PinOff /> : <Pin />}
      <span>{pinned ? "Unpin" : "Pin"}</span>
    </MenuItem>
  );
}

/**
 * Delete, or a submenu offering the Thread with the children its sidebar
 * row lists, as the row's own menu does.
 */
function DeleteMenuItem({
  thread,
  editing,
}: {
  readonly thread: ThreadDetailData;
  readonly editing: ThreadEditingController;
}) {
  // Read as the menu opens, so it follows the sidebar's latest count.
  const children = editing.childCount(thread.id);
  if (children === 0)
    return (
      <MenuItem tone="danger" onClick={() => editing.openDelete(thread)}>
        <Trash2 />
        <span>Delete</span>
      </MenuItem>
    );
  return (
    <MenuSubmenuRoot>
      <MenuSubmenuTrigger tone="danger">
        <Trash2 />
        <span>Delete</span>
      </MenuSubmenuTrigger>
      <MenuPopup
        className="thread-actions-menu thread-actions-submenu"
        alignOffset={-4}
      >
        <MenuItem
          tone="danger"
          onClick={() => editing.openDelete(thread, children)}
        >
          <span>All {children + 1} Threads</span>
        </MenuItem>
        <MenuItem tone="danger" onClick={() => editing.openDelete(thread)}>
          <span>This Thread</span>
        </MenuItem>
      </MenuPopup>
    </MenuSubmenuRoot>
  );
}

/** Copy Thread ID and Export, which a Space's menu leaves out. */
function ThreadIdentityItems({
  thread,
  onDownload,
}: {
  readonly thread: ThreadDetailData;
  readonly onDownload: (format: "markdown" | "json") => void;
}) {
  return (
    <>
      <MenuItem onClick={() => void copyThreadId(thread.id)}>
        <Hash />
        <span>Copy Thread ID</span>
      </MenuItem>
      <ThreadMenuSubmenu icon={<FileDown />} label="Export">
        <MenuItem onClick={() => onDownload("markdown")}>
          <FileText />
          <span>Markdown</span>
        </MenuItem>
        <MenuItem onClick={() => onDownload("json")}>
          <Braces />
          <span>JSON</span>
        </MenuItem>
      </ThreadMenuSubmenu>
    </>
  );
}
