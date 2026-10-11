import type { ThreadData } from "@dx/api";
import { PROJECTLESS_PROJECT_NAME } from "@dx/domain";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import type { ThreadListClientItem } from "../../shared/api/client.js";
import { EXECUTION_ENVIRONMENT_DISPLAY_NAME } from "../../shared/execution-environment-copy.js";
import type { PendingProjectlessCreation } from "../../shared/new-thread-surface.js";
import { threadColorAttributes } from "../../shared/thread-color.js";
import { OrbIcon } from "../../shared/ui/orb-icon.js";
import { PendingThreadTitle } from "../../shared/ui/thread-title.js";
import { focusSidebarCommandItem } from "./sidebar-command-focus.js";
import {
  SidebarChildThreadRows,
  useThreadChildrenExpansion,
} from "./sidebar-thread-children.js";
import {
  type SidebarThreadListProps,
  SidebarThreadRow,
} from "./sidebar-thread-row.js";

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
        {...threadColorAttributes({ id: creation.id })}
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

export interface SidebarThreadRowsProps extends SidebarThreadListProps {
  readonly threads: ReadonlyArray<ThreadListClientItem>;
}

export function SidebarThreadRows({
  threads,
  activeThreadId,
  projectNames,
  onThreadNavigate,
  onThreadPointerEnter,
  onThreadPointerLeave,
  onThreadMenuOpen,
  onSetArchived,
  onSetPinned,
  onUnfollow,
  archivingThreadId,
  pinningThreadId,
}: SidebarThreadRowsProps) {
  const expansion = useThreadChildrenExpansion();
  const rowProps = {
    activeThreadId,
    projectNames,
    onThreadNavigate,
    onThreadPointerEnter,
    onThreadPointerLeave,
    onThreadMenuOpen,
    onSetArchived,
    onSetPinned,
    onUnfollow,
    archivingThreadId,
    pinningThreadId,
  };
  return (
    <>
      {threads.map((thread) => {
        const childCount =
          expansion === undefined ? 0 : (thread.childCount ?? 0);
        const expanded =
          childCount > 0 && expansion?.expanded.has(thread.id) === true;
        return (
          <React.Fragment key={thread.id}>
            <SidebarThreadRow
              thread={thread}
              projectName={
                projectNames.get(thread.projectId) ?? PROJECTLESS_PROJECT_NAME
              }
              selected={thread.id === activeThreadId}
              archiving={archivingThreadId === thread.id}
              pinning={pinningThreadId === thread.id}
              childCount={childCount}
              expanded={expanded}
              onToggleChildren={expansion?.toggle}
              onThreadNavigate={onThreadNavigate}
              onThreadPointerEnter={onThreadPointerEnter}
              onThreadPointerLeave={onThreadPointerLeave}
              onThreadMenuOpen={onThreadMenuOpen}
              onSetArchived={onSetArchived}
              onSetPinned={onSetPinned}
              onUnfollow={onUnfollow}
            />
            {expanded ? (
              <SidebarChildThreadRows parent={thread} {...rowProps} />
            ) : null}
          </React.Fragment>
        );
      })}
    </>
  );
}
