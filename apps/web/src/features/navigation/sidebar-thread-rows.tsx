import type { ThreadData } from "@dx/api";
import { Link } from "@tanstack/react-router";
import { Archive, ArchiveRestore, Pin } from "lucide-react";
import * as React from "react";
import { EXECUTION_ENVIRONMENT_DISPLAY_NAME } from "../../shared/execution-environment-copy.js";
import type { PendingProjectlessCreation } from "../../shared/new-thread-surface.js";
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
  archivingThreadId,
  pinningThreadId,
}: SidebarThreadRowsProps) {
  return (
    <>
      {threads.map((thread) => (
        <SidebarThreadRow
          key={thread.id}
          thread={thread}
          projectName={projectNames.get(thread.projectId) ?? "Project"}
          selected={thread.id === activeThreadId}
          archiving={archivingThreadId === thread.id}
          pinning={pinningThreadId === thread.id}
          onThreadNavigate={onThreadNavigate}
          onThreadPointerEnter={onThreadPointerEnter}
          onThreadPointerLeave={onThreadPointerLeave}
          onSetArchived={onSetArchived}
          onSetPinned={onSetPinned}
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
}: SidebarThreadRowProps) {
  const activityStatus =
    thread.lifecycleState === "archived" ? "idle" : thread.activityStatus;
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
      </div>
    </ThreadContextMenu>
  );
});
