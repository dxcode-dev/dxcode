import type { SpaceThreadItem, SpaceThreadState } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { useParams, useSearch } from "@tanstack/react-router";
import {
  Archive,
  CircleAlert,
  CircleCheck,
  CircleX,
  GitPullRequestArrow,
} from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { useTimeText } from "../../../shared/hooks/use-clock.js";
import { Avatar } from "../../../shared/ui/avatar.js";
import { OrbIcon } from "../../../shared/ui/orb-icon.js";
import { compactAge, epochOf, spaceThreadStateLabel } from "../space-format.js";
import {
  SpaceThreadsContext,
  useOpenSpaceThread,
} from "../use-open-space-thread.js";
import { useSpaceThreadItem } from "./space-card-queries.js";
import "./space-cards.css";

/** A thread's state as an icon: the Orb while it works or rests, else a mark. */
function SpaceThreadStateIcon({
  state,
}: {
  readonly state: SpaceThreadState | undefined;
}) {
  switch (state) {
    case "needs_you":
      return <CircleAlert className="space-thread-state-icon" aria-hidden />;
    case "failed":
      return <CircleX className="space-thread-state-icon" aria-hidden />;
    case "ready_to_ship":
      return (
        <GitPullRequestArrow className="space-thread-state-icon" aria-hidden />
      );
    case "shipped":
      return <CircleCheck className="space-thread-state-icon" aria-hidden />;
    case "archived":
      return <Archive className="space-thread-state-icon" aria-hidden />;
    default:
      return (
        <OrbIcon
          className="space-thread-state-icon"
          staticWhenIdle
          activityStatus={state === "working" ? "working" : "idle"}
          aria-hidden="true"
        />
      );
  }
}

/** The Space whose page this is: the Thread the route opens. */
const useSpaceThreadId = () => {
  const space = React.use(SpaceThreadsContext);
  const params = useParams({ strict: false });
  return space?.spaceThreadId ?? (params.threadId as ThreadId | undefined);
};

const useSelectedThread = () =>
  (useSearch({ strict: false }) as { readonly thread?: string }).thread;

function RelativeTime({ item }: { readonly item: SpaceThreadItem }) {
  const text = useTimeText((now) =>
    compactAge(epochOf(item.lastActivityAt), now),
  );
  return (
    <time
      className="space-thread-card-time"
      dateTime={new Date(item.lastActivityAt.epochMilliseconds).toISOString()}
    >
      {text}
    </time>
  );
}

const describe = (item: SpaceThreadItem) =>
  [
    item.title,
    spaceThreadStateLabel(item.state),
    ...(item.statusLine === null ? [] : [item.statusLine]),
  ].join(", ") +
  (item.requestedBy === null ? "" : `, requested by ${item.requestedBy.name}`);

/**
 * A thread a Space started, as a live card in the Space's chat: its state,
 * title, status line, when it last moved, and who asked for it. Opens the
 * thread beside the chat.
 */
export function SpaceThreadCard({ threadId }: { readonly threadId: string }) {
  const { identity } = useAuthenticatedIdentity();
  const spaceThreadId = useSpaceThreadId();
  const item = useSpaceThreadItem(identity.id, spaceThreadId, threadId);
  const open = useOpenSpaceThread();
  const selected = useSelectedThread() === threadId;
  if (item === undefined)
    return (
      <button
        type="button"
        className="space-thread-card"
        data-loading=""
        aria-label="Thread"
        onClick={() => open(threadId as ThreadId)}
      >
        <SpaceThreadStateIcon state={undefined} />
        <span className="space-thread-card-text">
          <span className="space-thread-card-title space-thread-card-placeholder" />
          <span className="space-thread-card-line space-thread-card-placeholder" />
        </span>
      </button>
    );
  return (
    <button
      type="button"
      className="space-thread-card"
      data-state={item.state}
      data-selected={selected ? "" : undefined}
      aria-label={describe(item)}
      aria-current={selected ? "true" : undefined}
      onClick={() => open(threadId as ThreadId)}
    >
      <SpaceThreadStateIcon state={item.state} />
      <span className="space-thread-card-text">
        <span className="space-thread-card-title">{item.title}</span>
        <span className="space-thread-card-line">
          <span className="space-thread-card-state">
            {spaceThreadStateLabel(item.state)}
          </span>
          {item.statusLine === null ? null : (
            <>
              {" · "}
              <span className="space-thread-card-status">
                {item.statusLine}
              </span>
            </>
          )}
        </span>
      </span>
      <RelativeTime item={item} />
      {item.requestedBy === null ? (
        <span className="space-thread-card-requester" />
      ) : (
        <span
          className="space-thread-card-requester"
          title={`Requested by ${item.requestedBy.name}`}
        >
          <Avatar
            name={item.requestedBy.name}
            seed={item.requestedBy.userId}
            {...(item.requestedBy.avatarUrl === undefined
              ? {}
              : { image: item.requestedBy.avatarUrl })}
          />
        </span>
      )}
    </button>
  );
}

/**
 * A thread a Space started, named in running text: a small chip with its
 * state and title. `label` is the link's own text, shown until the thread
 * loads. Opens the thread beside the chat.
 */
export function SpaceThreadChip({
  threadId,
  label,
}: {
  readonly threadId: string;
  readonly label?: React.ReactNode;
}) {
  const { identity } = useAuthenticatedIdentity();
  const spaceThreadId = useSpaceThreadId();
  const item = useSpaceThreadItem(identity.id, spaceThreadId, threadId);
  const open = useOpenSpaceThread();
  return (
    <button
      type="button"
      className="space-thread-chip"
      data-state={item?.state}
      aria-label={item === undefined ? undefined : describe(item)}
      onClick={() => open(threadId as ThreadId)}
    >
      <SpaceThreadStateIcon state={item?.state} />
      <span className="space-thread-chip-title">
        {item?.title ?? label ?? "Thread"}
      </span>
    </button>
  );
}
