import type { SpaceThreadItem } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { ChevronDown, ListTree } from "lucide-react";
import * as React from "react";
import { useTimeText } from "../../shared/hooks/use-clock.js";
import { threadColorAttributes } from "../../shared/thread-color.js";
import { Avatar } from "../../shared/ui/avatar.js";
import { EmptyState } from "../../shared/ui/empty-state.js";
import { OrbIcon } from "../../shared/ui/orb-icon.js";
import { compactAge, epochOf, groupSpaceThreads } from "./space-format.js";
import "./spaces.css";

function ThreadRowAge({ thread }: { readonly thread: SpaceThreadItem }) {
  const at = epochOf(thread.lastActivityAt);
  return (
    <span className="space-thread-age">
      {useTimeText((now) => compactAge(at, now))}
    </span>
  );
}

/** One thread the Space started: status, title, what it does, who asked. */
function SpaceThreadRow({
  thread,
  active,
  onOpen,
}: {
  readonly thread: SpaceThreadItem;
  readonly active: boolean;
  readonly onOpen: (threadId: ThreadId) => void;
}) {
  // Opening a thread is seeing it, so the open one is never unread.
  const unread = thread.unread === true && !active;
  return (
    <li>
      <button
        type="button"
        className="space-thread-row"
        aria-current={active ? "true" : undefined}
        data-state={thread.state}
        onClick={() => onOpen(thread.id)}
        {...threadColorAttributes(thread)}
      >
        <span className="space-thread-status">
          <OrbIcon
            activityStatus={thread.state === "working" ? "working" : "idle"}
            unread={unread}
            aria-hidden="false"
            aria-label={unread ? "Unread" : thread.state}
          />
        </span>
        <span className="space-thread-text">
          <strong>{thread.title}</strong>
          {thread.statusLine === null ? null : (
            <small>{thread.statusLine}</small>
          )}
        </span>
        {thread.requestedBy === null ? null : (
          <span
            className="space-thread-requester"
            title={`Requested by ${thread.requestedBy.name}`}
          >
            <Avatar
              name={thread.requestedBy.name}
              image={thread.requestedBy.avatarUrl}
              seed={thread.requestedBy.userId}
            />
          </span>
        )}
        <ThreadRowAge thread={thread} />
      </button>
    </li>
  );
}

/** The Threads tab: the Space's threads by state, each state collapsible. */
export function SpaceThreadSections({
  threads,
  activeThreadId,
  onOpenThread,
}: {
  readonly threads: ReadonlyArray<SpaceThreadItem> | undefined;
  readonly activeThreadId: ThreadId | undefined;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const [toggled, setToggled] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  if (threads === undefined)
    return <div className="space-panel-loading" aria-busy="true" />;
  if (threads.length === 0)
    return (
      <EmptyState
        icon={<ListTree />}
        title="No Threads Yet"
        description="Ask this Space to take something on. The threads it starts show up here."
      />
    );
  return (
    <div className="space-thread-sections">
      {groupSpaceThreads(threads).map((section) => {
        const collapsed = section.collapsed !== toggled.has(section.state);
        return (
          <section
            key={section.state}
            className="space-thread-section"
            aria-label={section.label}
          >
            <button
              type="button"
              className="thread-group-heading space-thread-section-heading"
              data-collapsed={collapsed || undefined}
              aria-expanded={!collapsed}
              onClick={() =>
                setToggled((current) => {
                  const next = new Set(current);
                  if (next.has(section.state)) next.delete(section.state);
                  else next.add(section.state);
                  return next;
                })
              }
            >
              <span>{section.label}</span>
              <ChevronDown
                className="space-thread-section-chevron"
                aria-hidden="true"
              />
              <i />
              <small>{section.items.length}</small>
            </button>
            {collapsed ? null : (
              <ul className="space-thread-list">
                {section.items.map((thread) => (
                  <SpaceThreadRow
                    key={thread.id}
                    thread={thread}
                    active={thread.id === activeThreadId}
                    onOpen={onOpenThread}
                  />
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
