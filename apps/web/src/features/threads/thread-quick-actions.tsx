import type { ThreadDetailData, ThreadQuickAction } from "@dx/api";
import { useQuery } from "@tanstack/react-query";
import { ClockFading } from "lucide-react";
import type * as React from "react";
import { useNowMinute } from "../../shared/hooks/use-clock.js";
import { threadQuickActionsQueryOptions } from "./thread-quick-actions-queries.js";

/**
 * Asks for the actions Clef Flash picked after the agent message
 * `messageId` and shows them: nothing until the answer is about that
 * message, and nothing when Clef did not answer. Loaded after the composer
 * paints. It takes what the Thread page already has (the ending reply, the
 * draft, snooze, the send icon) as props, so none of that code moves out of
 * the page's first load.
 */
export function ClefQuickActions({
  thread,
  messageId,
  composing,
  replyIcon,
  onReply,
  snoozedAt,
  snoozeUntilNeeded,
}: {
  readonly thread: ThreadDetailData;
  readonly messageId: string;
  /** Reply chips hide while the person types or attaches. */
  readonly composing: boolean;
  readonly replyIcon: React.ReactNode;
  readonly onReply: (reply: string) => void;
  /** Whether the Thread is snoozed at `now`. */
  readonly snoozedAt: (now: number) => boolean;
  /** Absent where snoozing isn't offered on this page. */
  readonly snoozeUntilNeeded?: () => void;
}) {
  const { data } = useQuery(
    threadQuickActionsQueryOptions(thread.id, messageId),
  );
  const now = useNowMinute();
  // Snooze Until I'm Needed is the owner's, for an awake, active Thread no
  // other Thread started (a child follows its parent).
  const onSnooze =
    (thread.access ?? "owner") === "owner" &&
    thread.parentThreadId === undefined &&
    !snoozedAt(now)
      ? snoozeUntilNeeded
      : undefined;
  if (data?.messageId !== messageId) return null;
  return (
    <ThreadQuickActions
      actions={
        composing
          ? data.actions.filter(({ kind }) => kind !== "reply")
          : data.actions
      }
      replyIcon={replyIcon}
      onReply={onReply}
      {...(onSnooze === undefined ? {} : { onSnooze })}
    />
  );
}

/**
 * The row above the composer once the agent's turn ends, in the order Clef
 * Flash picked: Snooze Until I'm Needed for the owner, and a chip per reply
 * taken from what the agent asked or proposed, which sends its text as the
 * next message.
 */
function ThreadQuickActions({
  actions,
  replyIcon,
  onReply,
  onSnooze,
}: {
  readonly actions: ReadonlyArray<ThreadQuickAction>;
  readonly replyIcon: React.ReactNode;
  readonly onReply: (reply: string) => void;
  /** Absent when this person cannot snooze this Thread. */
  readonly onSnooze?: () => void;
}) {
  const shown = actions.filter(
    (action) => action.kind === "reply" || onSnooze !== undefined,
  );
  if (shown.length === 0) return null;
  return (
    <div
      className="thread-quick-actions"
      role="toolbar"
      aria-label="Quick actions"
      data-thread-quick-action-row=""
    >
      {shown.map((action) =>
        action.kind === "snooze" ? (
          <button
            key="snooze"
            type="button"
            className="thread-quick-action"
            data-thread-quick-action="snooze"
            aria-label="Snooze Until I'm Needed"
            title="Hide this thread until its next turn finishes"
            onClick={onSnooze}
          >
            <ClockFading aria-hidden="true" />
            <span>Snooze Until I'm Needed</span>
          </button>
        ) : (
          <button
            key={`reply:${action.text}`}
            type="button"
            className="thread-quick-action"
            data-thread-quick-action="reply"
            aria-label={`Reply "${action.text}"`}
            title={action.text}
            onClick={() => onReply(action.text)}
          >
            <span className="thread-quick-action-send" aria-hidden="true">
              {replyIcon}
            </span>
            <span>{action.text}</span>
          </button>
        ),
      )}
    </div>
  );
}
