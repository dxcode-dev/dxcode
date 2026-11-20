import type { ThreadData } from "@dx/api";
import { Link } from "@tanstack/react-router";
import {
  AlarmClock,
  AlarmClockOff,
  Archive,
  ArchiveRestore,
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  Hash,
  Link2,
  Pencil,
  Pin,
  PinOff,
  Trash2,
} from "lucide-react";
import type { ReactNode } from "react";
import { copyThreadId, copyThreadUrl } from "../../shared/thread-copy.js";
import { useOptionalThreadEditing } from "../../shared/thread-editing.js";
import type { ThreadSnoozeController } from "../../shared/thread-snooze.js";
import {
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSubmenuRoot,
  MenuSubmenuTrigger,
} from "../../shared/ui/menu.js";
import { RowContextMenu } from "../../shared/ui/row-context-menu.js";
import { SubthreadIcon } from "../../shared/ui/subthread-icon.js";
import { ThreadColorSubmenu } from "../../shared/ui/thread-color-submenu.js";
import { SnoozeMenuItems } from "../../shared/ui/thread-snooze-menu.js";

/** A parent's action: on All N Threads, with its children, or This Thread. */
function FamilyContextSubmenu({
  icon,
  label,
  count,
  danger = false,
  disabled = false,
  onAll,
  onThis,
}: {
  readonly icon: ReactNode;
  readonly label: string;
  /** The child Threads listed under it. */
  readonly count: number;
  readonly danger?: boolean;
  readonly disabled?: boolean;
  readonly onAll: () => void;
  readonly onThis: () => void;
}) {
  const tone = danger ? "danger" : undefined;
  return (
    <MenuSubmenuRoot>
      <MenuSubmenuTrigger tone={tone} disabled={disabled}>
        {icon}
        <span>{label}</span>
      </MenuSubmenuTrigger>
      <MenuPopup alignOffset={-4}>
        <MenuItem tone={tone} onClick={onAll}>
          <span>All {count + 1} Threads</span>
        </MenuItem>
        <MenuItem tone={tone} onClick={onThis}>
          <span>This Thread</span>
        </MenuItem>
      </MenuPopup>
    </MenuSubmenuRoot>
  );
}

/** What a Thread's context menu offers, and for which Thread. */
export interface ThreadContextMenuProps {
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
}

/** The menu's items for one Thread. */
function ThreadContextMenuItems({
  thread,
  onSetArchived,
  onSetPinned,
  archiving,
  pinning,
  creating = false,
  subthreads,
  sourceThread,
  snooze,
}: ThreadContextMenuProps) {
  const editing = useOptionalThreadEditing();
  const own = thread.access === undefined || thread.access === "owner";
  const title = thread.title;

  return (
    <>
      {subthreads === undefined ? null : (
        <>
          <MenuItem onClick={subthreads.onToggle}>
            {subthreads.expanded ? <ChevronsDownUp /> : <ChevronsUpDown />}
            <span>
              {subthreads.expanded
                ? "Collapse Subthreads"
                : "Expand Subthreads"}
            </span>
          </MenuItem>
          <MenuSeparator />
        </>
      )}
      {sourceThread === undefined ? null : (
        <>
          <MenuItem
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
          </MenuItem>
          <MenuSeparator />
        </>
      )}
      {own ? (
        <>
          {thread.lifecycleState === "active" ? (
            <MenuItem
              disabled={pinning}
              onClick={() => onSetPinned(thread.pinnedAt === undefined)}
            >
              {thread.pinnedAt === undefined ? <Pin /> : <PinOff />}
              <span>{thread.pinnedAt === undefined ? "Pin" : "Unpin"}</span>
            </MenuItem>
          ) : null}
          {snooze === undefined ? null : snooze.snoozed ? (
            <MenuItem onClick={() => snooze.controller.wake(thread.id)}>
              <AlarmClockOff />
              <span>Wake</span>
            </MenuItem>
          ) : (
            <MenuSubmenuRoot>
              <MenuSubmenuTrigger>
                <AlarmClock />
                <span>Snooze</span>
              </MenuSubmenuTrigger>
              <MenuPopup alignOffset={-4}>
                <SnoozeMenuItems
                  threadId={thread.id}
                  snooze={snooze.controller}
                />
              </MenuPopup>
            </MenuSubmenuRoot>
          )}
          {editing === undefined || title === undefined || creating ? null : (
            <>
              <MenuItem
                onClick={() => editing.openRename({ id: thread.id, title })}
              >
                <Pencil />
                <span>Rename</span>
              </MenuItem>
              <ThreadColorSubmenu
                thread={thread}
                onSelect={(color) => editing.setColor(thread.id, color)}
              />
            </>
          )}
          <MenuSeparator />
          {subthreads !== undefined ? (
            <FamilyContextSubmenu
              icon={
                thread.lifecycleState === "active" ? (
                  <Archive />
                ) : (
                  <ArchiveRestore />
                )
              }
              label={
                thread.lifecycleState === "active" ? "Archive" : "Unarchive"
              }
              count={subthreads.count}
              disabled={archiving}
              onAll={() =>
                onSetArchived(thread.lifecycleState === "active", true)
              }
              onThis={() => onSetArchived(thread.lifecycleState === "active")}
            />
          ) : (
            <MenuItem
              disabled={archiving}
              onClick={() => onSetArchived(thread.lifecycleState === "active")}
            >
              {thread.lifecycleState === "active" ? (
                <Archive />
              ) : (
                <ArchiveRestore />
              )}
              <span>
                {thread.lifecycleState === "active" ? "Archive" : "Unarchive"}
              </span>
            </MenuItem>
          )}
          {editing === undefined ||
          title === undefined ||
          creating ? null : subthreads === undefined ? (
            <MenuItem
              tone="danger"
              onClick={() => editing.openDelete({ id: thread.id, title })}
            >
              <Trash2 />
              <span>Delete</span>
            </MenuItem>
          ) : (
            <FamilyContextSubmenu
              icon={<Trash2 />}
              label="Delete"
              count={subthreads.count}
              danger
              onAll={() =>
                editing.openDelete({ id: thread.id, title }, subthreads.count)
              }
              onThis={() => editing.openDelete({ id: thread.id, title })}
            />
          )}
          <MenuSeparator />
        </>
      ) : null}
      <MenuSubmenuRoot>
        <MenuSubmenuTrigger>
          <Copy />
          <span>Copy</span>
        </MenuSubmenuTrigger>
        <MenuPopup alignOffset={-4}>
          <MenuItem onClick={() => void copyThreadUrl(thread.id)}>
            <Link2 />
            <span>Thread URL</span>
          </MenuItem>
          <MenuItem onClick={() => void copyThreadId(thread.id)}>
            <Hash />
            <span>Thread ID</span>
          </MenuItem>
        </MenuPopup>
      </MenuSubmenuRoot>
    </>
  );
}

export function ThreadContextMenu({
  children,
  ...menu
}: ThreadContextMenuProps & { readonly children: ReactNode }) {
  return (
    <RowContextMenu
      menuKey={menu.thread.id}
      items={() => <ThreadContextMenuItems {...menu} />}
      onOpenChange={menu.onOpenChange}
    >
      {children}
    </RowContextMenu>
  );
}
