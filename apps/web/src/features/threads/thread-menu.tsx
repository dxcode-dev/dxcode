import { Menu } from "@base-ui/react/menu";
import type { ProjectData, ThreadDetailData } from "@dx/api";
import { useQuery } from "@tanstack/react-query";
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
  DollarSign,
  Ellipsis,
  FileDown,
  FileText,
  FolderGit2,
  Gauge,
  Hash,
  Info,
  Link2,
  Network,
  Pencil,
  Pin,
  PinOff,
  Share2,
  Sparkles,
  Trash2,
} from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../shared/auth/auth-context.js";
import {
  type CommandId,
  getBrowserCommandRegistry,
} from "../../shared/commands/command-registry.js";
import { ShortcutKeycaps } from "../../shared/commands/shortcut-keycaps.js";
import { useNowMinute } from "../../shared/hooks/use-clock.js";
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
import { ClaudeIcon } from "../../shared/ui/claude-icon.js";
import { OrbIcon } from "../../shared/ui/orb-icon.js";
import { SubthreadIcon } from "../../shared/ui/subthread-icon.js";
import { ThreadColorSubmenu } from "../../shared/ui/thread-color-submenu.js";
import { SnoozeMenuItems } from "../../shared/ui/thread-snooze-menu.js";
import { formatCost } from "../../shared/usage-cost.js";
import { BugReportDialog } from "./bug-reports/bug-report-dialog.js";
import type { DictationRecord } from "./dictation/dictation-session.js";
import { threadOrbMemoryQueryOptions } from "./orb-memory/orb-memory-queries.js";
import { threadCostQueryOptions } from "./thread-cost-queries.js";
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
  const orbControls = canUseOrb(thread);
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
                onClick={() => void copyThreadUrl(thread.id)}
              >
                <Link2 />
                <span>Copy Thread URL</span>
                <ShortcutKeycaps keycaps={copyUrlKeycaps} emptyLabel="" />
              </Menu.Item>
              <Menu.Item
                className="thread-menu-item"
                onClick={() => void copyThreadId(thread.id)}
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
              {showDetails || (!orbControls && !own) ? null : (
                <>
                  {orbControls ? (
                    <>
                      <Menu.Separator className="thread-menu-separator" />
                      <OrbMenuItem threadId={thread.id} />
                    </>
                  ) : null}
                  {own ? (
                    <>
                      <Menu.Separator className="thread-menu-separator" />
                      <ThreadCostMenuItems thread={thread} />
                    </>
                  ) : null}
                </>
              )}
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
                  {/* A Thread kept from a deleted project stays archived. */}
                  {thread.projectDeleted === true ? null : (
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
                  )}
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
              {/* A phone lists what the Thread runs on, its Orb, Project,
                  and cost before Report Bug, which stays last. */}
              {showDetails ? (
                <ThreadDetailItems thread={thread} project={project} />
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
      {canUseOrb(thread) ? <OrbMenuItem threadId={thread.id} /> : null}
      <Menu.Separator className="thread-menu-separator" />
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
      {own ? <ThreadCostMenuItems thread={thread} /> : null}
    </>
  );
}

/**
 * The Orb's state is for those who may open its Terminal: the owner and
 * contributors, while the Thread is active (archiving stops the Orb), once
 * its Orb was first prepared, as the Thread's views are.
 */
const canUseOrb = (thread: ThreadDetailData) =>
  (thread.access === undefined ||
    thread.access === "owner" ||
    thread.access === "contribute") &&
  thread.lifecycleState === "active" &&
  thread.executionWorkspace.ready;

/** Orb memory answers `unavailable` when no daemon serves this Thread. */
const ORB_STATE_LABELS = {
  running: "Running",
  paused: "Paused",
  unavailable: "Not running",
} as const;

/**
 * The Orb's state, from the Orb memory read the Thread page already polls,
 * which never wakes it. The reference's Orb submenu (its size and
 * resources, Memory and CPU Usage, Copy Sync CLI Command, and Network
 * Routing) waits on backend support (#1155).
 */
function OrbMenuItem({
  threadId,
}: {
  readonly threadId: ThreadDetailData["id"];
}) {
  const orb = useQuery(threadOrbMemoryQueryOptions(threadId));
  const workspace = orb.data?.workspace;
  const state =
    workspace !== undefined
      ? ORB_STATE_LABELS[workspace]
      : orb.isError
        ? ORB_STATE_LABELS.unavailable
        : "Checking…";
  return (
    <Menu.Item className="thread-menu-item thread-menu-detail-item">
      <OrbIcon reducedMotion />
      <span className="thread-menu-detail-label">Orb</span>
      <span className="thread-menu-detail-value">{state}</span>
    </Menu.Item>
  );
}

/**
 * The Thread's estimated model cost, from the owner's usage, which opens
 * Usage settings. Claude Code runs on the person's own plan, outside dx's
 * usage, so a Claude Code Thread says its cost is not tracked.
 */
function ThreadCostMenuItems({
  thread,
}: {
  readonly thread: ThreadDetailData;
}) {
  const { identity } = useAuthenticatedIdentity();
  const cost = useQuery(
    threadCostQueryOptions(
      identity.id,
      thread.id,
      DateTime.toEpochMillis(thread.createdAt),
    ),
  );
  const claudeCode =
    threadSelectionSummary(thread.agentInitialization.selection).kind ===
    "claude-code";
  const label =
    cost.data !== undefined
      ? formatCost(cost.data.amountMicros)
      : cost.isError
        ? "Cost unavailable"
        : "Estimating cost…";
  const title =
    cost.data === undefined
      ? undefined
      : [
          `Estimated model cost${cost.data.since === undefined ? "" : ` since ${cost.data.since}`}`,
          cost.data.unknownEvents === 0
            ? undefined
            : `${cost.data.unknownEvents} model ${cost.data.unknownEvents === 1 ? "turn has" : "turns have"} no price`,
        ]
          .filter((part) => part !== undefined)
          .join("; ");
  return (
    <>
      <Menu.Item
        className="thread-menu-item"
        title={title}
        render={<Link to="/settings/$section" params={{ section: "usage" }} />}
      >
        <DollarSign />
        <span>{label}</span>
      </Menu.Item>
      {claudeCode ? (
        <Menu.Item className="thread-menu-item" disabled>
          <Info />
          <span>Claude Code Costs Not Tracked</span>
        </Menu.Item>
      ) : null}
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
