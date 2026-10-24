import { Menu } from "@base-ui/react/menu";
import type { ThreadData } from "@dx/api";
import { Link } from "@tanstack/react-router";
import { DateTime } from "effect";
import {
  AlarmClock,
  AlarmClockOff,
  Archive,
  ArchiveRestore,
  Bookmark,
  ChevronDown,
  CornerDownRight,
  Pin,
} from "lucide-react";
import * as React from "react";
import type { ThreadListClientItem } from "../../shared/api/client.js";
import { EXECUTION_ENVIRONMENT_DISPLAY_NAME } from "../../shared/execution-environment-copy.js";
import { useTimeText } from "../../shared/hooks/use-clock.js";
import { threadColorAttributes } from "../../shared/thread-color.js";
import {
  type ThreadSnoozeController,
  useOptionalThreadSnooze,
} from "../../shared/thread-snooze.js";
import {
  snoozeRemainingText,
  snoozeWakeText,
} from "../../shared/thread-snooze-presets.js";
import { Avatar } from "../../shared/ui/avatar.js";
import { OrbIcon } from "../../shared/ui/orb-icon.js";
import { SubthreadIcon } from "../../shared/ui/subthread-icon.js";
import { SnoozeMenuItems } from "../../shared/ui/thread-snooze-menu.js";
import {
  PendingThreadTitle,
  ThreadTitleText,
} from "../../shared/ui/thread-title.js";
import { isOptimisticThread } from "../threads/thread-mutations.js";
import {
  clearSidebarContextPress,
  focusSidebarCommandItem,
  noteSidebarContextPress,
} from "./sidebar-command-focus.js";
import { observeTitleOverflow } from "./sidebar-title-overflow.js";
import { ThreadContextMenu } from "./thread-context-menu.js";

/** A row click this soon after its menu opened is the long press lifting. */
const LONG_PRESS_CLICK_MS = 1_000;

function SidebarThreadTitle({ thread }: { readonly thread: ThreadData }) {
  if (isOptimisticThread(thread)) return <PendingThreadTitle />;
  return <ThreadTitleText thread={thread} />;
}

/** How long a snoozed row has left, at its end while not hovered. */
function SnoozeCountdown({ wakeAt }: { readonly wakeAt: number }) {
  const remaining = useTimeText((now) => snoozeRemainingText(wakeAt, now));
  const until = useTimeText((now) => snoozeWakeText(wakeAt, now));
  return (
    <span className="thread-snooze-status" title={`Snoozed until ${until}`}>
      {remaining}
    </span>
  );
}

/** The row's Snooze action: a menu of wake times. */
function SnoozeRowButton({
  threadId,
  snooze,
}: {
  readonly threadId: ThreadData["id"];
  readonly snooze: ThreadSnoozeController;
}) {
  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label="Snooze thread"
        title="Snooze thread"
        disabled={snooze.pendingThreadId === threadId}
      >
        <AlarmClock />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner
          className="thread-menu-positioner"
          align="end"
          sideOffset={4}
        >
          <Menu.Popup className="thread-menu-popup thread-actions-menu">
            <SnoozeMenuItems
              threadId={threadId}
              snooze={snooze}
              itemClassName="thread-menu-item"
            />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/**
 * What a parent's child-count control shows: `2/3` while two of its three
 * children work and `3` while none do, tinted when any child's latest turn
 * failed and dotted when any finished a turn its viewer has not seen.
 */
function childActivity(thread: ThreadListClientItem, childCount: number) {
  const working = thread.childActivity?.working ?? 0;
  const unread = (thread.childActivity?.unread ?? 0) > 0;
  const failed = (thread.childActivity?.failed ?? 0) > 0;
  const summary = [
    working > 0 ? `${working} working` : undefined,
    failed ? `${thread.childActivity?.failed} with errors` : undefined,
    unread ? `${thread.childActivity?.unread} unread` : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(", ");
  return {
    text: working > 0 ? `${working}/${childCount}` : `${childCount}`,
    unread,
    failed,
    summary: summary === "" ? undefined : `: ${summary}`,
  };
}

/** A parent's child count, which expands and collapses its children. */
function SubthreadsToggle({
  status,
  label,
  expanded,
  onToggle,
}: {
  readonly status: ReturnType<typeof childActivity>;
  readonly label: string;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="thread-children-toggle"
      data-expanded={expanded ? "" : undefined}
      data-failed={status.failed ? "" : undefined}
      aria-expanded={expanded}
      aria-label={`${expanded ? "Collapse" : "Expand"} ${label} started from this thread${status.summary ?? ""}`}
      title={`${label}${status.summary ?? ""}`}
      onClick={onToggle}
    >
      <span className="thread-children-icon" aria-hidden>
        <CornerDownRight className="thread-children-corner" />
        <ChevronDown className="thread-children-chevron" />
      </span>
      <span className="thread-children-count">{status.text}</span>
      {status.unread ? (
        <span className="thread-children-unread" aria-hidden />
      ) : null}
    </button>
  );
}

/** What every Thread row in a sidebar list shares. */
export interface SidebarThreadListProps {
  readonly activeThreadId?: string;
  readonly projectNames: ReadonlyMap<string, string>;
  readonly onThreadNavigate: (threadId: ThreadData["id"]) => void;
  readonly onThreadPointerEnter: (
    thread: ThreadData,
    projectName: string,
    element: HTMLElement,
  ) => void;
  readonly onThreadPointerLeave: (threadId: ThreadData["id"]) => void;
  /** A row's context menu opened: its hover card gives way. */
  readonly onThreadMenuOpen?: (threadId: ThreadData["id"]) => void;
  /** `includeChildren` also archives or restores the Thread's children. */
  readonly onSetArchived: (
    threadId: ThreadData["id"],
    archived: boolean,
    includeChildren?: boolean,
  ) => void;
  readonly onSetPinned: (threadId: ThreadData["id"], pinned: boolean) => void;
  /** Unfollows another member's shared Thread, removing it from the sidebar. */
  readonly onUnfollow?: (threadId: ThreadData["id"]) => void;
  readonly archivingThreadId?: ThreadData["id"];
  readonly pinningThreadId?: ThreadData["id"];
}

export interface SidebarThreadRowProps
  extends Pick<
    SidebarThreadListProps,
    | "onThreadNavigate"
    | "onThreadPointerEnter"
    | "onThreadPointerLeave"
    | "onThreadMenuOpen"
    | "onSetArchived"
    | "onSetPinned"
    | "onUnfollow"
  > {
  readonly thread: ThreadListClientItem;
  readonly projectName: string;
  readonly selected: boolean;
  readonly archiving: boolean;
  readonly pinning: boolean;
  /** Child Threads listed under this row; zero shows no control. */
  readonly childCount?: number;
  readonly expanded?: boolean;
  readonly onToggleChildren?: (threadId: ThreadData["id"]) => void;
  /** This row is a child Thread listed under its parent. */
  readonly child?: boolean;
  /** Listed in the Snoozed section: asleep until `snoozedUntil`. */
  readonly snoozed?: boolean;
}

/**
 * Query results share unchanged thread objects across refetches, and the
 * handlers take a thread id, so a row re-renders only when its own thread,
 * selection, or pending action changes, not when another row or the list does.
 */
// biome-ignore lint/plugin: the list re-maps every row when one Thread changes; memo skips rows whose props kept their identity.
export const SidebarThreadRow = React.memo(function SidebarThreadRow({
  thread,
  projectName,
  selected,
  archiving,
  pinning,
  childCount = 0,
  expanded = false,
  onToggleChildren,
  child = false,
  snoozed = false,
  onThreadNavigate,
  onThreadPointerEnter,
  onThreadPointerLeave,
  onThreadMenuOpen,
  onSetArchived,
  onSetPinned,
  onUnfollow,
}: SidebarThreadRowProps) {
  const menuOpenedAt = React.useRef(Number.NEGATIVE_INFINITY);
  const activityStatus =
    thread.lifecycleState === "archived" ? "idle" : thread.activityStatus;
  const hasChildren = childCount > 0 && onToggleChildren !== undefined;
  const childLabel = `${childCount} ${childCount === 1 ? "thread" : "threads"}`;
  // Opening a Thread is seeing it, so the open one is never unread.
  const unread = thread.unread === true && !selected;
  const failed = thread.turnFailed === true;
  const childStatus = hasChildren
    ? childActivity(thread, childCount)
    : undefined;
  const parentThreadId = thread.parentThreadId;
  const sharedWithMe = thread.access !== undefined && thread.access !== "owner";
  const owner = thread.participants?.find((person) => person.owner);
  // A shared Thread shows only its owner at the row's end; hover actions
  // open to its left, so the avatar never moves.
  const shared =
    sharedWithMe ||
    thread.sharing !== undefined ||
    (thread.participants?.length ?? 0) > 1;
  const avatars =
    shared && owner !== undefined ? (
      <span
        className="thread-row-avatars"
        title={`Thread owner: ${owner.name}`}
      >
        <Avatar name={owner.name} image={owner.image} seed={owner.userId} />
      </span>
    ) : null;
  const snooze = useOptionalThreadSnooze();
  // Only an owned active root Thread snoozes; a child follows its parent.
  const snoozable =
    snooze !== undefined &&
    !sharedWithMe &&
    !child &&
    thread.lifecycleState === "active" &&
    parentThreadId === undefined &&
    !isOptimisticThread(thread);
  // Outside the Snoozed section a snooze still on the row has passed its
  // wake time: the Thread woke and the owner has not opened it since.
  const woke =
    snooze !== undefined &&
    !snoozed &&
    !sharedWithMe &&
    thread.lifecycleState === "active" &&
    thread.snoozedUntil !== undefined;
  // Hover actions: Unfollow for a shared Thread; Pin, Snooze, and Archive,
  // Wake and Archive while snoozed, or only Unarchive, for the person's own.
  const actionCount = sharedWithMe
    ? onUnfollow === undefined
      ? 0
      : 1
    : thread.lifecycleState === "active"
      ? snoozed || !snoozable
        ? 2
        : 3
      : 1;
  return (
    <ThreadContextMenu
      thread={thread}
      archiving={archiving}
      pinning={pinning}
      creating={isOptimisticThread(thread)}
      onOpenChange={(open) => {
        if (!open) return;
        menuOpenedAt.current = Date.now();
        onThreadMenuOpen?.(thread.id);
      }}
      subthreads={
        hasChildren
          ? {
              count: childCount,
              expanded,
              onToggle: () => onToggleChildren(thread.id),
            }
          : undefined
      }
      sourceThread={
        // A family shares as one unit, so a shared child's parent is too.
        parentThreadId === undefined
          ? undefined
          : {
              id: parentThreadId,
              onOpen: () => onThreadNavigate(parentThreadId),
            }
      }
      onSetArchived={(archived, includeChildren) =>
        onSetArchived(thread.id, archived, includeChildren)
      }
      onSetPinned={(pinned) => onSetPinned(thread.id, pinned)}
      snooze={
        snoozable && snooze !== undefined
          ? { controller: snooze, snoozed }
          : undefined
      }
    >
      <div
        className="thread-row-shell"
        data-avatars={avatars === null ? undefined : ""}
        data-actions={actionCount === 0 ? undefined : actionCount}
        data-children={hasChildren ? "" : undefined}
        data-child={child ? "" : undefined}
        data-snooze={snoozed ? "snoozed" : woke ? "woke" : undefined}
        data-error={failed && !snoozed && !woke ? "" : undefined}
        style={
          childStatus === undefined
            ? undefined
            : ({
                "--thread-children-glyphs": childStatus.text.length,
              } as React.CSSProperties)
        }
        onPointerEnter={(event) => {
          // A tap is not a hover: touch opens the Thread, not its preview.
          if (event.pointerType === "touch") return;
          onThreadPointerEnter(thread, projectName, event.currentTarget);
        }}
        onPointerLeave={() => onThreadPointerLeave(thread.id)}
      >
        <Link
          className={`thread-row ${selected ? "selected" : ""}`}
          data-command-sidebar-item
          aria-current={selected ? "page" : undefined}
          {...threadColorAttributes(thread)}
          to="/threads/$threadId"
          params={{ threadId: thread.id }}
          onFocus={(event) => focusSidebarCommandItem(event.currentTarget)}
          onPointerDown={noteSidebarContextPress}
          onContextMenu={(event) =>
            clearSidebarContextPress(event.currentTarget)
          }
          onClick={(event) => {
            // Lifting the finger after a long press clicks the row; that
            // press opened the menu, so it must not also open the Thread.
            if (Date.now() - menuOpenedAt.current < LONG_PRESS_CLICK_MS) {
              event.preventDefault();
              return;
            }
            // Opening a woken Thread is seeing it.
            if (woke) snooze?.wake(thread.id);
            onThreadNavigate(thread.id);
          }}
        >
          {child ? (
            <CornerDownRight className="thread-child-marker" aria-hidden />
          ) : null}
          <span className="thread-executor-icon">
            <OrbIcon
              activityStatus={activityStatus}
              unread={unread}
              aria-hidden="false"
              aria-label={`${
                thread.lifecycleState === "archived"
                  ? `${EXECUTION_ENVIRONMENT_DISPLAY_NAME} paused`
                  : activityStatus === "working"
                    ? `${EXECUTION_ENVIRONMENT_DISPLAY_NAME} working`
                    : `${EXECUTION_ENVIRONMENT_DISPLAY_NAME} idle`
              }${unread ? ", unread" : ""}`}
            />
            {parentThreadId === undefined ? null : (
              <SubthreadIcon
                className="thread-child-badge"
                label="Started from another thread"
              />
            )}
          </span>
          {thread.pinnedAt === undefined ? null : (
            <Pin className="thread-pin-icon" aria-label="Pinned" role="img" />
          )}
          <strong data-title-overflow ref={observeTitleOverflow}>
            <span className="thread-row-title-text">
              <SidebarThreadTitle thread={thread} />
            </span>
          </strong>
        </Link>
        {snoozed && thread.snoozedUntil !== undefined ? (
          <SnoozeCountdown
            wakeAt={DateTime.toEpochMillis(thread.snoozedUntil)}
          />
        ) : woke ? (
          <button
            type="button"
            className="thread-snooze-status thread-woke"
            aria-label="Dismiss Woke"
            title="Woke from snooze. Dismiss"
            onClick={() => snooze?.wake(thread.id)}
          >
            <AlarmClock aria-hidden="true" />
            <span role="status">Woke</span>
          </button>
        ) : failed ? (
          <span
            className="thread-error-status"
            title="The latest turn ended in an error"
          >
            Error
          </span>
        ) : null}
        {avatars}
        {hasChildren && childStatus !== undefined ? (
          <SubthreadsToggle
            status={childStatus}
            label={childLabel}
            expanded={expanded}
            onToggle={() => onToggleChildren(thread.id)}
          />
        ) : null}
        {sharedWithMe ? (
          onUnfollow === undefined ? null : (
            <span className="thread-hover-actions">
              <button
                type="button"
                aria-label="Unfollow thread"
                title="Unfollow"
                onClick={() => onUnfollow(thread.id)}
              >
                <Bookmark fill="currentColor" />
              </button>
            </span>
          )
        ) : (
          <span className="thread-hover-actions">
            {snoozed && snooze !== undefined ? (
              <button
                type="button"
                aria-label="Wake thread"
                title="Wake thread"
                disabled={snooze.pendingThreadId === thread.id}
                onClick={() => snooze.wake(thread.id)}
              >
                <AlarmClockOff />
              </button>
            ) : thread.lifecycleState === "active" ? (
              <button
                type="button"
                aria-label={
                  thread.pinnedAt === undefined ? "Pin thread" : "Unpin thread"
                }
                title={
                  thread.pinnedAt === undefined ? "Pin thread" : "Unpin thread"
                }
                disabled={pinning}
                onClick={() =>
                  onSetPinned(thread.id, thread.pinnedAt === undefined)
                }
              >
                <Pin />
              </button>
            ) : null}
            {snoozable && !snoozed && snooze !== undefined ? (
              <SnoozeRowButton threadId={thread.id} snooze={snooze} />
            ) : null}
            <button
              type="button"
              aria-label={
                thread.lifecycleState === "archived"
                  ? "Unarchive thread"
                  : "Archive thread"
              }
              title={
                thread.lifecycleState === "archived"
                  ? "Unarchive thread"
                  : "Archive thread"
              }
              disabled={archiving}
              onClick={() =>
                onSetArchived(thread.id, thread.lifecycleState !== "archived")
              }
            >
              {thread.lifecycleState === "archived" ? (
                <ArchiveRestore />
              ) : (
                <Archive />
              )}
            </button>
          </span>
        )}
      </div>
    </ThreadContextMenu>
  );
});
