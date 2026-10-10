import type { ThreadData } from "@dx/api";
import { PROJECTLESS_PROJECT_NAME } from "@dx/domain";
import { Link } from "@tanstack/react-router";
import { Archive, ArchiveRestore, Bookmark, Pin } from "lucide-react";
import * as React from "react";
import { EXECUTION_ENVIRONMENT_DISPLAY_NAME } from "../../shared/execution-environment-copy.js";
import type { PendingProjectlessCreation } from "../../shared/new-thread-surface.js";
import { Avatar, ParticipantStack } from "../../shared/ui/avatar.js";
import { OrbIcon } from "../../shared/ui/orb-icon.js";
import {
  PendingThreadTitle,
  ThreadTitleText,
} from "../../shared/ui/thread-title.js";
import { isOptimisticThread } from "../threads/thread-mutations.js";
import { ThreadContextMenu } from "./thread-context-menu.js";

function focusSidebarCommandItem(element: HTMLElement) {
  const items = document.querySelectorAll<HTMLElement>(
    "[data-command-sidebar-item]",
  );
  for (const item of items) delete item.dataset.commandFocused;
  element.dataset.commandFocused = "true";
}

function SidebarThreadTitle({ thread }: { readonly thread: ThreadData }) {
  if (isOptimisticThread(thread)) return <PendingThreadTitle />;
  return <ThreadTitleText thread={thread} />;
}

export function SidebarPendingThreadRow({
  creation,
  activeThreadId,
  onThreadNavigate,
}: {
  readonly creation: PendingProjectlessCreation;
  readonly activeThreadId?: string;
  readonly onThreadNavigate: (threadId: ThreadData["id"]) => void;
}) {
  const selected = creation.id === activeThreadId;
  return (
    <div className="thread-row-shell" data-pending-thread-row>
      <Link
        className={`thread-row ${selected ? "selected" : ""}`}
        data-command-sidebar-item
        aria-current={selected ? "page" : undefined}
        to="/threads/$threadId"
        params={{ threadId: creation.id }}
        onFocus={(event) => focusSidebarCommandItem(event.currentTarget)}
        onClick={() => onThreadNavigate(creation.id)}
      >
        <span className="thread-executor-icon">
          <OrbIcon
            activityStatus="idle"
            aria-hidden="false"
            aria-label={`${EXECUTION_ENVIRONMENT_DISPLAY_NAME} idle`}
          />
        </span>
        <strong>
          <PendingThreadTitle />
        </strong>
      </Link>
    </div>
  );
}

export interface SidebarThreadRowsProps {
  readonly threads: ReadonlyArray<ThreadData>;
  readonly activeThreadId?: string;
  readonly projectNames: ReadonlyMap<string, string>;
  readonly onThreadNavigate: (threadId: ThreadData["id"]) => void;
  readonly onThreadPointerEnter: (
    thread: ThreadData,
    projectName: string,
    element: HTMLElement,
  ) => void;
  readonly onThreadPointerLeave: (threadId: ThreadData["id"]) => void;
  readonly onSetArchived: (
    threadId: ThreadData["id"],
    archived: boolean,
  ) => void;
  readonly onSetPinned: (threadId: ThreadData["id"], pinned: boolean) => void;
  /** Unfollows another member's shared Thread, removing it from the sidebar. */
  readonly onUnfollow?: (threadId: ThreadData["id"]) => void;
  readonly archivingThreadId?: ThreadData["id"];
  readonly pinningThreadId?: ThreadData["id"];
}

export function SidebarThreadRows({
  threads,
  activeThreadId,
  projectNames,
  onThreadNavigate,
  onThreadPointerEnter,
  onThreadPointerLeave,
  onSetArchived,
  onSetPinned,
  onUnfollow,
  archivingThreadId,
  pinningThreadId,
}: SidebarThreadRowsProps) {
  return (
    <>
      {threads.map((thread) => (
        <SidebarThreadRow
          key={thread.id}
          thread={thread}
          projectName={
            projectNames.get(thread.projectId) ?? PROJECTLESS_PROJECT_NAME
          }
          selected={thread.id === activeThreadId}
          archiving={archivingThreadId === thread.id}
          pinning={pinningThreadId === thread.id}
          onThreadNavigate={onThreadNavigate}
          onThreadPointerEnter={onThreadPointerEnter}
          onThreadPointerLeave={onThreadPointerLeave}
          onSetArchived={onSetArchived}
          onSetPinned={onSetPinned}
          onUnfollow={onUnfollow}
        />
      ))}
    </>
  );
}

interface SidebarThreadRowProps
  extends Pick<
    SidebarThreadRowsProps,
    | "onThreadNavigate"
    | "onThreadPointerEnter"
    | "onThreadPointerLeave"
    | "onSetArchived"
    | "onSetPinned"
    | "onUnfollow"
  > {
  readonly thread: ThreadData;
  readonly projectName: string;
  readonly selected: boolean;
  readonly archiving: boolean;
  readonly pinning: boolean;
}

/**
 * Query results share unchanged thread objects across refetches, and the
 * handlers take a thread id, so a row re-renders only when its own thread,
 * selection, or pending action changes, not when another row or the list does.
 */
const SidebarThreadRow = React.memo(function SidebarThreadRow({
  thread,
  projectName,
  selected,
  archiving,
  pinning,
  onThreadNavigate,
  onThreadPointerEnter,
  onThreadPointerLeave,
  onSetArchived,
  onSetPinned,
  onUnfollow,
}: SidebarThreadRowProps) {
  const activityStatus =
    thread.lifecycleState === "archived" ? "idle" : thread.activityStatus;
  const sharedWithMe = thread.access !== undefined && thread.access !== "owner";
  const owner = thread.participants?.find((person) => person.owner);
  // Shared Threads keep their people at the row's end; hover actions open
  // to their left, so the avatars never move.
  const avatars = sharedWithMe ? (
    owner === undefined ? null : (
      <span
        className="thread-row-avatars"
        title={`Thread owner: ${owner.name}`}
      >
        <Avatar name={owner.name} image={owner.image} seed={owner.userId} />
      </span>
    )
  ) : thread.participants !== undefined &&
    (thread.participants.length > 1 || thread.sharing !== undefined) ? (
    <span className="thread-row-avatars">
      <ParticipantStack participants={thread.participants} limit={2} />
    </span>
  ) : null;
  return (
    <ThreadContextMenu
      thread={thread}
      archiving={archiving}
      pinning={pinning}
      onSetArchived={(archived) => onSetArchived(thread.id, archived)}
      onSetPinned={(pinned) => onSetPinned(thread.id, pinned)}
    >
      <div
        className="thread-row-shell"
        data-avatars={avatars === null ? undefined : ""}
        onPointerEnter={(event) =>
          onThreadPointerEnter(thread, projectName, event.currentTarget)
        }
        onPointerLeave={() => onThreadPointerLeave(thread.id)}
      >
        <Link
          className={`thread-row ${selected ? "selected" : ""}`}
          data-command-sidebar-item
          aria-current={selected ? "page" : undefined}
          to="/threads/$threadId"
          params={{ threadId: thread.id }}
          onFocus={(event) => focusSidebarCommandItem(event.currentTarget)}
          onClick={() => onThreadNavigate(thread.id)}
        >
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
          </span>
          {thread.pinnedAt === undefined ? null : (
            <Pin className="thread-pin-icon" aria-label="Pinned" role="img" />
          )}
          <strong>
            <SidebarThreadTitle thread={thread} />
          </strong>
        </Link>
        {avatars}
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
