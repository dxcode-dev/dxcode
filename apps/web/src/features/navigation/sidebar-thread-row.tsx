import type { ThreadData } from "@dx/api";
import { Link } from "@tanstack/react-router";
import {
  Archive,
  ArchiveRestore,
  Bookmark,
  ChevronDown,
  CornerDownRight,
  Pin,
} from "lucide-react";
import * as React from "react";
import { EXECUTION_ENVIRONMENT_DISPLAY_NAME } from "../../shared/execution-environment-copy.js";
import { threadColorAttributes } from "../../shared/thread-color.js";
import { Avatar } from "../../shared/ui/avatar.js";
import { OrbIcon } from "../../shared/ui/orb-icon.js";
import { SubthreadIcon } from "../../shared/ui/subthread-icon.js";
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
  readonly thread: ThreadData;
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
}

/**
 * Query results share unchanged thread objects across refetches, and the
 * handlers take a thread id, so a row re-renders only when its own thread,
 * selection, or pending action changes, not when another row or the list does.
 */
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
  // Hover actions: Unfollow for a shared Thread; Pin and Archive, or only
  // Unarchive, for the person's own.
  const actionCount = sharedWithMe
    ? onUnfollow === undefined
      ? 0
      : 1
    : thread.lifecycleState === "active"
      ? 2
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
        // A shared Thread's parent may not be shared with this viewer.
        parentThreadId === undefined || sharedWithMe
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
    >
      <div
        className="thread-row-shell"
        data-avatars={avatars === null ? undefined : ""}
        data-actions={actionCount === 0 ? undefined : actionCount}
        data-children={hasChildren ? "" : undefined}
        data-child={child ? "" : undefined}
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
            onThreadNavigate(thread.id);
          }}
        >
          {child ? (
            <CornerDownRight className="thread-child-marker" aria-hidden />
          ) : null}
          <span className="thread-executor-icon">
            <OrbIcon
              activityStatus={activityStatus}
              aria-hidden="false"
              aria-label={
                thread.lifecycleState === "archived"
                  ? `${EXECUTION_ENVIRONMENT_DISPLAY_NAME} paused`
                  : activityStatus === "working"
                    ? `${EXECUTION_ENVIRONMENT_DISPLAY_NAME} working`
                    : `${EXECUTION_ENVIRONMENT_DISPLAY_NAME} idle`
              }
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
        {avatars}
        {hasChildren ? (
          <button
            type="button"
            className="thread-children-toggle"
            data-expanded={expanded ? "" : undefined}
            aria-expanded={expanded}
            aria-label={`${expanded ? "Collapse" : "Expand"} ${childLabel} started from this thread`}
            title={childLabel}
            onClick={() => onToggleChildren(thread.id)}
          >
            <span className="thread-children-icon" aria-hidden>
              <CornerDownRight className="thread-children-corner" />
              <ChevronDown className="thread-children-chevron" />
            </span>
            <span>{childCount}</span>
          </button>
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
            {thread.lifecycleState === "active" ? (
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
