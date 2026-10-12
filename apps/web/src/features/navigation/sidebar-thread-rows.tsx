import { PROJECTLESS_PROJECT_NAME } from "@dx/domain";
import * as React from "react";
import type { ThreadListClientItem } from "../../shared/api/client.js";
import {
  SidebarChildThreadRows,
  useThreadChildrenExpansion,
} from "./sidebar-thread-children.js";
import {
  type SidebarThreadListProps,
  SidebarThreadRow,
} from "./sidebar-thread-row.js";

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
