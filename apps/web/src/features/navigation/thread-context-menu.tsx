import { ContextMenu } from "@base-ui/react/context-menu";
import type { ThreadData } from "@dx/api";
import { Link } from "@tanstack/react-router";
import {
  AlarmClock,
  AlarmClockOff,
  Archive,
  ArchiveRestore,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  Hash,
  Link2,
  Pencil,
  Pin,
  PinOff,
} from "lucide-react";
import type { ReactNode } from "react";
import { useNowMinute } from "../../shared/hooks/use-clock.js";
import { useOptionalThreadEditing } from "../../shared/thread-editing.js";
import type { ThreadSnoozeController } from "../../shared/thread-snooze.js";
import { snoozePresets } from "../../shared/thread-snooze-presets.js";
import { absoluteThreadUrl } from "../../shared/thread-url.js";
import { SubthreadIcon } from "../../shared/ui/subthread-icon.js";
import { ThreadColorSubmenu } from "../../shared/ui/thread-color-submenu.js";

const copy = (text: string) => {
  void navigator.clipboard.writeText(text);
};

/** The Snooze submenu's wake times, read as it opens. */
function SnoozeContextItems({
  threadId,
  snooze,
}: {
  readonly threadId: ThreadData["id"];
  readonly snooze: ThreadSnoozeController;
}) {
  const now = useNowMinute();
  return (
    <>
      {snoozePresets(now).map((preset) => (
        <ContextMenu.Item
          key={preset.id}
          className="thread-context-item"
          onClick={() => snooze.snooze(threadId, preset.wakeAt(Date.now()))}
        >
          <span>{preset.label}</span>
          <small className="thread-snooze-when">{preset.when}</small>
        </ContextMenu.Item>
      ))}
      <ContextMenu.Separator className="thread-context-separator" />
      <ContextMenu.Item
        className="thread-context-item"
        onClick={() => snooze.snoozeCustom(threadId)}
      >
        <span>Custom…</span>
      </ContextMenu.Item>
    </>
  );
}

export function ThreadContextMenu({
  thread,
  onSetArchived,
  onSetPinned,
  archiving,
  pinning,
  creating = false,
  subthreads,
  sourceThread,
  snooze,
  onOpenChange,
  children,
}: {
  readonly thread: {
    readonly id: ThreadData["id"];
    readonly title?: ThreadData["title"];
    readonly color?: ThreadData["color"];
    readonly parentThreadId?: ThreadData["parentThreadId"];
    readonly parentColor?: ThreadData["parentColor"];
    readonly lifecycleState: "active" | "archived";
    readonly pinnedAt?: unknown;
    /** Someone else's shared Thread: pinning and archiving stay theirs. */
    readonly access?: "owner" | "contribute" | "view";
  };
  /** `includeChildren` also archives the Thread's child Threads. */
  readonly onSetArchived: (
    archived: boolean,
    includeChildren?: boolean,
  ) => void;
  readonly onSetPinned: (pinned: boolean) => void;
  readonly archiving: boolean;
  readonly pinning: boolean;
  /** The server has not created the Thread yet, so it cannot be edited. */
  readonly creating?: boolean;
  /** A parent row: its child Threads and whether they show. */
  readonly subthreads?: {
    readonly count: number;
    readonly expanded: boolean;
    readonly onToggle: () => void;
  };
  /** A child row: the Thread that started it. */
  readonly sourceThread?: {
    readonly id: ThreadData["id"];
    readonly onOpen: () => void;
  };
  /** A Thread that can snooze; `snoozed` offers Wake instead. */
  readonly snooze?: {
    readonly controller: ThreadSnoozeController;
    readonly snoozed: boolean;
  };
  readonly onOpenChange?: (open: boolean) => void;
  readonly children: ReactNode;
}) {
  const editing = useOptionalThreadEditing();
  const own = thread.access === undefined || thread.access === "owner";
  const title = thread.title;

  return (
    <ContextMenu.Root onOpenChange={onOpenChange}>
      <ContextMenu.Trigger render={<div className="thread-context-trigger" />}>
        {children}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="thread-context-positioner">
          <ContextMenu.Popup
            className="thread-context-menu"
            // Only a keyboard close returns focus to the row; after a click
            // the row would keep a focus highlight beside the new selection.
            finalFocus={(closeType) => closeType === "keyboard"}
          >
            {subthreads === undefined ? null : (
              <>
                <ContextMenu.Item
                  className="thread-context-item"
                  onClick={subthreads.onToggle}
                >
                  {subthreads.expanded ? (
                    <ChevronsDownUp />
                  ) : (
                    <ChevronsUpDown />
                  )}
                  <span>
                    {subthreads.expanded
                      ? "Collapse Subthreads"
                      : "Expand Subthreads"}
                  </span>
                </ContextMenu.Item>
                <ContextMenu.Separator className="thread-context-separator" />
              </>
            )}
            {sourceThread === undefined ? null : (
              <>
                <ContextMenu.Item
                  className="thread-context-item"
                  render={
                    <Link
                      to="/threads/$threadId"
                      params={{ threadId: sourceThread.id }}
                    />
                  }
                  onClick={sourceThread.onOpen}
                >
                  <SubthreadIcon strokeWidth={2} />
                  <span>Open Source Thread</span>
                </ContextMenu.Item>
                <ContextMenu.Separator className="thread-context-separator" />
              </>
            )}
            {own ? (
              <>
                {thread.lifecycleState === "active" ? (
                  <ContextMenu.Item
                    className="thread-context-item"
                    disabled={pinning}
                    onClick={() => onSetPinned(thread.pinnedAt === undefined)}
                  >
                    {thread.pinnedAt === undefined ? <Pin /> : <PinOff />}
                    <span>
                      {thread.pinnedAt === undefined ? "Pin" : "Unpin"}
                    </span>
                  </ContextMenu.Item>
                ) : null}
                {snooze === undefined ? null : snooze.snoozed ? (
                  <ContextMenu.Item
                    className="thread-context-item"
                    disabled={snooze.controller.pendingThreadId === thread.id}
                    onClick={() => snooze.controller.wake(thread.id)}
                  >
                    <AlarmClockOff />
                    <span>Wake</span>
                  </ContextMenu.Item>
                ) : (
                  <ContextMenu.SubmenuRoot>
                    <ContextMenu.SubmenuTrigger
                      className="thread-context-item"
                      disabled={snooze.controller.pendingThreadId === thread.id}
                    >
                      <AlarmClock />
                      <span>Snooze</span>
                      <ChevronRight />
                    </ContextMenu.SubmenuTrigger>
                    <ContextMenu.Portal>
                      <ContextMenu.Positioner
                        className="thread-context-positioner"
                        sideOffset={4}
                        alignOffset={-4}
                      >
                        <ContextMenu.Popup className="thread-context-menu">
                          <SnoozeContextItems
                            threadId={thread.id}
                            snooze={snooze.controller}
                          />
                        </ContextMenu.Popup>
                      </ContextMenu.Positioner>
                    </ContextMenu.Portal>
                  </ContextMenu.SubmenuRoot>
                )}
                {editing === undefined ||
                title === undefined ||
                creating ? null : (
                  <>
                    <ContextMenu.Item
                      className="thread-context-item"
                      onClick={() =>
                        editing.openRename({ id: thread.id, title })
                      }
                    >
                      <Pencil />
                      <span>Rename</span>
                    </ContextMenu.Item>
                    <ThreadColorSubmenu
                      thread={thread}
                      itemClassName="thread-context-item"
                      onSelect={(color) => editing.setColor(thread.id, color)}
                    />
                  </>
                )}
                <ContextMenu.Separator className="thread-context-separator" />
                {thread.lifecycleState === "active" &&
                subthreads !== undefined ? (
                  <ContextMenu.SubmenuRoot>
                    <ContextMenu.SubmenuTrigger
                      className="thread-context-item"
                      disabled={archiving}
                    >
                      <Archive />
                      <span>Archive</span>
                      <ChevronRight />
                    </ContextMenu.SubmenuTrigger>
                    <ContextMenu.Portal>
                      <ContextMenu.Positioner
                        className="thread-context-positioner"
                        sideOffset={4}
                        alignOffset={-4}
                      >
                        <ContextMenu.Popup className="thread-context-menu">
                          <ContextMenu.Item
                            className="thread-context-item"
                            onClick={() => onSetArchived(true, true)}
                          >
                            <span>All {subthreads.count + 1} Threads</span>
                          </ContextMenu.Item>
                          <ContextMenu.Item
                            className="thread-context-item"
                            onClick={() => onSetArchived(true)}
                          >
                            <span>This Thread</span>
                          </ContextMenu.Item>
                        </ContextMenu.Popup>
                      </ContextMenu.Positioner>
                    </ContextMenu.Portal>
                  </ContextMenu.SubmenuRoot>
                ) : (
                  <ContextMenu.Item
                    className="thread-context-item"
                    disabled={archiving}
                    onClick={() =>
                      onSetArchived(thread.lifecycleState === "active")
                    }
                  >
                    {thread.lifecycleState === "active" ? (
                      <Archive />
                    ) : (
                      <ArchiveRestore />
                    )}
                    <span>
                      {thread.lifecycleState === "active"
                        ? "Archive"
                        : "Unarchive"}
                    </span>
                  </ContextMenu.Item>
                )}
                <ContextMenu.Separator className="thread-context-separator" />
              </>
            ) : null}
            <ContextMenu.SubmenuRoot>
              <ContextMenu.SubmenuTrigger className="thread-context-item">
                <Copy />
                <span>Copy</span>
                <ChevronRight />
              </ContextMenu.SubmenuTrigger>
              <ContextMenu.Portal>
                <ContextMenu.Positioner
                  className="thread-context-positioner"
                  sideOffset={4}
                  alignOffset={-4}
                >
                  <ContextMenu.Popup className="thread-context-menu">
                    <ContextMenu.Item
                      className="thread-context-item"
                      onClick={() =>
                        copy(absoluteThreadUrl(thread.id, window.location.href))
                      }
                    >
                      <Link2 />
                      <span>Thread URL</span>
                    </ContextMenu.Item>
                    <ContextMenu.Item
                      className="thread-context-item"
                      onClick={() => copy(thread.id)}
                    >
                      <Hash />
                      <span>Thread ID</span>
                    </ContextMenu.Item>
                  </ContextMenu.Popup>
                </ContextMenu.Positioner>
              </ContextMenu.Portal>
            </ContextMenu.SubmenuRoot>
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
