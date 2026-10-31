import { Menu } from "@base-ui/react/menu";
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
  ChevronRight,
  Ellipsis,
  FileDown,
  FileText,
  FolderGit2,
  Gauge,
  Hash,
  Link2,
  Network,
  Pencil,
  Pin,
  PinOff,
  Share2,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import * as React from "react";
import {
  type CommandId,
  getBrowserCommandRegistry,
} from "../../shared/commands/command-registry.js";
import { ShortcutKeycaps } from "../../shared/commands/shortcut-keycaps.js";
import { useNowMinute } from "../../shared/hooks/use-clock.js";
import { useOptionalThreadArchive } from "../../shared/thread-archive.js";
import {
  type ThreadEditingController,
  useOptionalThreadEditing,
} from "../../shared/thread-editing.js";
import {
  type ThreadSnoozeController,
  useOptionalThreadSnooze,
} from "../../shared/thread-snooze.js";
import { absoluteThreadUrl } from "../../shared/thread-url.js";
import { Button } from "../../shared/ui/button.js";
import { ClaudeIcon } from "../../shared/ui/claude-icon.js";
import { SubthreadIcon } from "../../shared/ui/subthread-icon.js";
import { ThreadColorSubmenu } from "../../shared/ui/thread-color-submenu.js";
import { SnoozeMenuItems } from "../../shared/ui/thread-snooze-menu.js";
import { BugReportDialog } from "./bug-reports/bug-report-dialog.js";
import type { DictationRecord } from "./dictation/dictation-session.js";
import {
  serializeThreadJson,
  serializeThreadMarkdown,
  threadExportFilename,
} from "./thread-export.js";
import { threadSelectionSummary } from "./thread-selection-summary.js";
import { ThreadPresentationContext } from "./thread-session-context.js";
import type { TranscriptViewModel } from "./transcript-view-model.js";

/** A Thread menu entry that opens a submenu of its own items. */
export function ThreadMenuSubmenu({
  icon,
  label,
  popupClassName = "",
  children,
}: {
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly popupClassName?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <Menu.SubmenuRoot>
      <Menu.SubmenuTrigger className="thread-menu-item">
        {icon}
        <span>{label}</span>
        <ChevronRight />
      </Menu.SubmenuTrigger>
      <Menu.Portal>
        <Menu.Positioner
          className="thread-menu-positioner"
          sideOffset={4}
          alignOffset={-4}
        >
          <Menu.Popup
            className={`thread-menu-popup thread-actions-menu thread-actions-submenu ${popupClassName}`}
          >
            {children}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.SubmenuRoot>
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
  const copyUrlKeycaps = useCommandKeycaps("navigation.copy-url");
  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setAnnouncement(`${label} copied.`);
    } catch {
      setAnnouncement(`Could not copy the ${label}.`);
    }
  };
  const download = (format: "markdown" | "json") => {
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
      <Menu.Root>
        <Menu.Trigger
          render={
            <Button
              className="thread-title-action"
              aria-label="More Actions"
              title="More Actions"
              variant="ghost"
              size="icon-xs"
            />
          }
        >
          <Ellipsis />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner
            className="thread-menu-positioner"
            align="start"
            sideOffset={4}
          >
            <Menu.Popup
              className={`thread-menu-popup thread-actions-menu${showDetails ? " thread-actions-menu-details" : ""}`}
            >
              {/* A family shares as one unit, so members reach the Thread
                  that started this one too: its starter, or for a Thread
                  started before dx recorded starters, the family's root. */}
              {thread.parentThreadId === undefined ? null : (
                <Menu.Item
                  className="thread-menu-item"
                  render={
                    <Link
                      to="/threads/$threadId"
                      params={{
                        threadId:
                          thread.startedByThreadId ?? thread.parentThreadId,
                      }}
                    />
                  }
                >
                  <SubthreadIcon strokeWidth={2} />
                  <span>Open Source Thread</span>
                </Menu.Item>
              )}
              <Menu.Item
                className="thread-menu-item"
                render={
                  <Link
                    to="/threads/$threadId/tree"
                    params={{ threadId: thread.id }}
                  />
                }
              >
                <Network />
                <span>Open Thread Tree</span>
              </Menu.Item>
              <Menu.Separator className="thread-menu-separator" />
              <Menu.Item
                className="thread-menu-item"
                onClick={() =>
                  void copy(
                    absoluteThreadUrl(thread.id, window.location.href),
                    "Thread URL",
                  )
                }
              >
                <Link2 />
                <span>Copy Thread URL</span>
                <ShortcutKeycaps keycaps={copyUrlKeycaps} emptyLabel="" />
              </Menu.Item>
              <Menu.Item
                className="thread-menu-item"
                onClick={() => void copy(thread.id, "Thread ID")}
              >
                <Hash />
                <span>Copy Thread ID</span>
              </Menu.Item>
              <ThreadMenuSubmenu icon={<FileDown />} label="Export">
                <Menu.Item
                  className="thread-menu-item"
                  onClick={() => download("markdown")}
                >
                  <FileText />
                  <span>Markdown</span>
                </Menu.Item>
                <Menu.Item
                  className="thread-menu-item"
                  onClick={() => download("json")}
                >
                  <Braces />
                  <span>JSON</span>
                </Menu.Item>
              </ThreadMenuSubmenu>
              {onOpenShare === undefined &&
              overflowItems === undefined &&
              !pinnable &&
              !snoozable ? null : (
                <Menu.Separator className="thread-menu-separator" />
              )}
              {overflowItems}
              {onOpenShare === undefined ? null : (
                <Menu.Item className="thread-menu-item" onClick={onOpenShare}>
                  <Share2 />
                  <span>Share…</span>
                </Menu.Item>
              )}
              {pinnable ? (
                <PinMenuItem threadId={thread.id} editing={editing} />
              ) : null}
              {snoozable ? (
                <SnoozeMenuItem thread={thread} snooze={snooze} />
              ) : null}
              {own ? (
                <>
                  <Menu.Separator className="thread-menu-separator" />
                  <Menu.Item
                    className="thread-menu-item"
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
                  </Menu.Item>
                  {editable ? (
                    <>
                      <Menu.Item
                        className="thread-menu-item"
                        onClick={() => editing.openRename(thread)}
                      >
                        <Pencil />
                        <span>Rename</span>
                      </Menu.Item>
                      <ThreadColorSubmenu
                        thread={thread}
                        itemClassName="thread-menu-item"
                        onSelect={(color) => editing.setColor(thread.id, color)}
                      />
                      <Menu.Separator className="thread-menu-separator" />
                      <DeleteMenuItem thread={thread} editing={editing} />
                    </>
                  ) : null}
                </>
              ) : null}
              <Menu.Separator className="thread-menu-separator" />
              <Menu.Item
                className="thread-menu-item"
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
              </Menu.Item>
              {showDetails ? (
                <ThreadDetailItems thread={thread} project={project} />
              ) : null}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      {reportingBug === undefined ? null : (
        <BugReportDialog
          thread={thread}
          project={project}
          transcript={transcript}
          changesOpen={reportingBug.changesOpen}
          dictation={reportingBug.dictation}
          onClose={() => setReportingBug(undefined)}
        />
      )}
      <span className="sr-only" aria-live="polite">
        {announcement}
        {announcement.startsWith("Could") ? (
          <X />
        ) : announcement ? (
          <Check />
        ) : null}
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

/**
 * What the Thread runs on, and its Project. The owner opens the Project from
 * here; members of a shared Thread cannot read the owner's Project.
 */
function ThreadDetailItems({
  thread,
  project,
}: {
  readonly thread: ThreadDetailData;
  readonly project?: Pick<ProjectData, "name">;
}) {
  const selection = threadSelectionSummary(
    thread.agentInitialization.selection,
  );
  const own = thread.access === undefined || thread.access === "owner";
  const projectName = project?.name ?? thread.projectName ?? "No project";
  return (
    <>
      <Menu.Separator className="thread-menu-separator" />
      <Menu.Item
        className="thread-menu-item thread-menu-detail-item"
        title={selection.title}
      >
        {selection.kind === "claude-code" ? (
          <ClaudeIcon />
        ) : selection.kind === "mode" ? (
          <Gauge />
        ) : (
          <Sparkles />
        )}
        <span className="thread-menu-detail-label">{selection.label}</span>
        {selection.detail === undefined ? null : (
          <span className="thread-menu-detail-value">{selection.detail}</span>
        )}
      </Menu.Item>
      <Menu.Item
        className="thread-menu-item"
        title={projectName}
        render={
          own ? (
            <Link
              to="/projects/$projectId"
              params={{ projectId: thread.projectId }}
            />
          ) : undefined
        }
      >
        <FolderGit2 />
        <span>{projectName}</span>
      </Menu.Item>
    </>
  );
}

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
      <Menu.Item
        className="thread-menu-item"
        disabled={snooze.pendingThreadId === thread.id}
        onClick={() => snooze.wake(thread.id)}
      >
        <AlarmClockOff />
        <span>Wake</span>
      </Menu.Item>
    );
  return (
    <ThreadMenuSubmenu icon={<AlarmClock />} label="Snooze">
      <SnoozeMenuItems
        threadId={thread.id}
        snooze={snooze}
        itemClassName="thread-menu-item"
      />
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
    <Menu.Item
      className="thread-menu-item"
      onClick={() => editing.setPinned(threadId, !pinned)}
    >
      {pinned ? <PinOff /> : <Pin />}
      <span>{pinned ? "Unpin" : "Pin"}</span>
    </Menu.Item>
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
      <Menu.Item
        className="thread-menu-item thread-menu-item-danger"
        onClick={() => editing.openDelete(thread)}
      >
        <Trash2 />
        <span>Delete</span>
      </Menu.Item>
    );
  return (
    <Menu.SubmenuRoot>
      <Menu.SubmenuTrigger className="thread-menu-item thread-menu-item-danger">
        <Trash2 />
        <span>Delete</span>
        <ChevronRight />
      </Menu.SubmenuTrigger>
      <Menu.Portal>
        <Menu.Positioner
          className="thread-menu-positioner"
          sideOffset={4}
          alignOffset={-4}
        >
          <Menu.Popup className="thread-menu-popup thread-actions-menu thread-actions-submenu">
            <Menu.Item
              className="thread-menu-item thread-menu-item-danger"
              onClick={() => editing.openDelete(thread, children)}
            >
              <span>All {children + 1} Threads</span>
            </Menu.Item>
            <Menu.Item
              className="thread-menu-item thread-menu-item-danger"
              onClick={() => editing.openDelete(thread)}
            >
              <span>This Thread</span>
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.SubmenuRoot>
  );
}
