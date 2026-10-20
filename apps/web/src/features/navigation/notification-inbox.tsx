import { Menu } from "@base-ui/react/menu";
import { Popover } from "@base-ui/react/popover";
import type { NotificationData } from "@dx/api";
import type { UserId } from "@dx/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AtSign, EllipsisVertical, MailOpen } from "lucide-react";
import * as React from "react";
import { Avatar } from "../../shared/ui/avatar.js";
import { Button } from "../../shared/ui/button.js";
import {
  markAllNotificationsReadMutationOptions,
  markNotificationsReadMutationOptions,
  notificationInboxQueryOptions,
} from "../notifications/notifications-queries.js";
import "./notification-inbox.css";
import { TimeText } from "../../shared/ui/time-text.js";

/** `now`, `5m ago`, `3h ago`, `2d ago`, `1mo ago`. */
const age = (iso: string, now: number) => {
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return months < 12 ? `${months}mo ago` : `${Math.floor(months / 12)}y ago`;
};

const exactTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const mentionPattern = /(^|\s)(@[\p{L}\p{N}_.-]+)/gu;

/** The excerpt as plain text with each `@handle` tinted. */
function Excerpt({ text }: { readonly text: string }) {
  const parts: Array<React.ReactNode> = [];
  let index = 0;
  for (const match of text.matchAll(mentionPattern)) {
    const start = (match.index ?? 0) + (match[1]?.length ?? 0);
    const handle = match[2] ?? "";
    if (start > index) parts.push(text.slice(index, start));
    parts.push(
      <span key={start} className="notification-mention">
        {handle}
      </span>,
    );
    index = start + handle.length;
  }
  if (index < text.length) parts.push(text.slice(index));
  return <span className="notification-excerpt">{parts}</span>;
}

function NotificationRow({
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
      <Avatar
        name={actor?.name ?? "Someone"}
        image={actor?.image}
        seed={actor?.userId ?? notification.id}
      />
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

/**
 * The `@` button beside search: the user's mentions, newest first. Opening
 * one marks it read and opens its Thread at the message.
 */
export function NotificationInbox({
  userId,
  onNavigate,
}: {
  readonly userId: UserId;
  readonly onNavigate: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const queryClient = useQueryClient();
  const inbox = useQuery(notificationInboxQueryOptions(userId));
  const markRead = useMutation(
    markNotificationsReadMutationOptions(queryClient, userId),
  );
  const markAllRead = useMutation(
    markAllNotificationsReadMutationOptions(queryClient, userId),
  );
  const unreadCount = inbox.data?.unreadCount ?? 0;
  const items = inbox.data?.items ?? [];
  const openNotification = (notification: NotificationData) => {
    if (notification.readAt === undefined) markRead.mutate([notification.id]);
    setOpen(false);
    onNavigate();
  };
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        render={
          <Button
            aria-label={
              unreadCount === 0 ? "Mentions" : `Mentions, ${unreadCount} unread`
            }
            title="Mentions"
            variant="ghost"
            size="icon-xs"
            className="notification-trigger"
            data-unread={unreadCount > 0 ? "" : undefined}
          />
        }
      >
        <AtSign />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          className="notification-positioner"
          side="bottom"
          align="start"
          sideOffset={6}
        >
          <Popover.Popup className="notification-popup" aria-label="Mentions">
            <header className="notification-header">
              <Popover.Title className="notification-title">
                Mentions
              </Popover.Title>
              <span className="notification-count">{unreadCount} Unread</span>
              <Menu.Root>
                <Menu.Trigger
                  className="notification-menu-trigger"
                  aria-label="Mentions options"
                >
                  <EllipsisVertical />
                </Menu.Trigger>
                <Menu.Portal>
                  <Menu.Positioner
                    className="thread-context-positioner notification-menu-positioner"
                    side="bottom"
                    align="end"
                    sideOffset={4}
                  >
                    <Menu.Popup className="thread-context-menu">
                      <Menu.Item
                        className="thread-context-item"
                        disabled={unreadCount === 0}
                        onClick={() => markAllRead.mutate()}
                      >
                        <MailOpen />
                        Mark All as Read
                      </Menu.Item>
                    </Menu.Popup>
                  </Menu.Positioner>
                </Menu.Portal>
              </Menu.Root>
            </header>
            {inbox.isPending ? (
              <p className="notification-empty">Loading mentions…</p>
            ) : inbox.isError && items.length === 0 ? (
              <p className="notification-empty" role="alert">
                Mentions could not be loaded.
              </p>
            ) : items.length === 0 ? (
              <p className="notification-empty">
                When someone mentions you in a shared thread, it shows up here.
              </p>
            ) : (
              <div className="notification-list">
                {items.map((notification) => (
                  <NotificationRow
                    key={notification.id}
                    notification={notification}
                    onOpen={openNotification}
                  />
                ))}
              </div>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
