import type { NotificationData } from "@dx/api";
import { Link } from "@tanstack/react-router";
import type * as React from "react";
import { DxWordmark } from "../../shared/brand/dx-wordmark.js";
import { Avatar } from "../../shared/ui/avatar.js";
import { TimeText } from "../../shared/ui/time-text.js";
import { age, exactTime } from "./inbox-time.js";

/**
 * One mention in the inbox. Its own module, loaded when the inbox first
 * opens, so the mention rows stay out of every page's first load.
 */

const mentionPattern = /(^|\s)(@[\p{L}\p{N}_.-]+)/gu;

/**
 * A mention as dx writes it (`@[Name](user:ID)`, `@[dx](agent)`,
 * `@[here](here)`) or a Markdown link (`[label](url)` or `[label](<url>)`).
 */
const markupPattern =
  /@\[([^\]\n]+)\]\((?:user:[^)\s]+|agent|here)\)|\[([^\]\n]+)\]\((?:<[^>\n]*>|[^)\s]+)\)/g;

/** Plain words from a stretch of Markdown: bold, strike, and code marks go. */
const unmarked = (text: string) => text.replace(/\*\*|__|~~|`/g, "");

/** Plain text with each `@handle` tinted. */
const withHandles = (text: string, key: number) => {
  const parts: Array<React.ReactNode> = [];
  let index = 0;
  for (const match of text.matchAll(mentionPattern)) {
    const start = (match.index ?? 0) + (match[1]?.length ?? 0);
    const handle = match[2] ?? "";
    if (start > index) parts.push(text.slice(index, start));
    parts.push(
      <span key={`${key}:${start}`} className="notification-mention">
        {handle}
      </span>,
    );
    index = start + handle.length;
  }
  if (index < text.length) parts.push(text.slice(index));
  return parts;
};

/**
 * The excerpt as the words people read: dx writes Markdown, so links show
 * their label, bold and code marks drop, and each mention, written as an
 * `@handle` or as dx's mention, is tinted.
 */
function Excerpt({ text }: { readonly text: string }) {
  const parts: Array<React.ReactNode> = [];
  let index = 0;
  for (const match of text.matchAll(markupPattern)) {
    const start = match.index ?? 0;
    if (start > index)
      parts.push(...withHandles(unmarked(text.slice(index, start)), index));
    const mentioned = match[1];
    parts.push(
      mentioned === undefined ? (
        unmarked(match[2] ?? "")
      ) : (
        <span key={start} className="notification-mention">
          @{mentioned}
        </span>
      ),
    );
    index = start + match[0].length;
  }
  if (index < text.length)
    parts.push(...withHandles(unmarked(text.slice(index)), index));
  return <span className="notification-excerpt">{parts}</span>;
}

export function NotificationRow({
  notification,
  onOpen,
}: {
  readonly notification: NotificationData;
  readonly onOpen: (notification: NotificationData) => void;
}) {
  const actor = notification.actor;
  const unread = notification.readAt === undefined;
  return (
    <Link
      to="/threads/$threadId"
      params={{ threadId: notification.threadId }}
      search={
        notification.messageId === undefined
          ? {}
          : { message: notification.messageId }
      }
      className="notification-row"
      data-unread={unread ? "" : undefined}
      onClick={() => onOpen(notification)}
    >
      {actor !== undefined && "kind" in actor ? (
        <span className="dx-avatar" role="img" aria-label="dx">
          <DxWordmark size="avatar" />
        </span>
      ) : (
        <Avatar
          name={actor?.name ?? "Someone"}
          image={actor?.image}
          seed={actor?.userId ?? notification.id}
        />
      )}
      <span className="notification-row-body">
        <span className="notification-row-heading">
          <strong>{notification.threadTitle}</strong>
          <time
            dateTime={notification.createdAt}
            title={exactTime.format(new Date(notification.createdAt))}
          >
            <TimeText text={(now) => age(notification.createdAt, now)} />
          </time>
        </span>
        <Excerpt text={notification.excerpt} />
      </span>
      {unread ? (
        <span className="notification-unread-dot">
          <span className="sr-only">Unread</span>
        </span>
      ) : null}
    </Link>
  );
}
