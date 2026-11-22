import type { NotificationData } from "@dx/api";
import type { UserId } from "@dx/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AtSign, EllipsisVertical, MailOpen } from "lucide-react";
import * as React from "react";
import { Button } from "../../shared/ui/button.js";
import {
  MenuItem,
  MenuPopup,
  MenuRoot,
  MenuTrigger,
} from "../../shared/ui/menu.js";
import {
  PopoverContent,
  PopoverRoot,
  PopoverTitle,
  PopoverTrigger,
} from "../../shared/ui/popover.js";
import {
  markAllNotificationsReadMutationOptions,
  markNotificationsReadMutationOptions,
  notificationInboxQueryOptions,
} from "../notifications/notifications-queries.js";
import "./notification-inbox.css";
import { lazyComponent } from "../../shared/stale-chunk.js";

// The rows load when the inbox first opens (notification-row.tsx).
const NotificationRow = lazyComponent(() =>
  import("./notification-row.js").then((module) => ({
    default: module.NotificationRow,
  })),
);

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
    <PopoverRoot open={open} onOpenChange={setOpen}>
      <PopoverTrigger
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
      </PopoverTrigger>
      <PopoverContent
        className="notification-popup"
        side="bottom"
        align="start"
        aria-label="Mentions"
      >
        <header className="notification-header">
          <PopoverTitle className="notification-title">Mentions</PopoverTitle>
          <span className="notification-count">{unreadCount} Unread</span>
          <MenuRoot>
            <MenuTrigger
              render={
                <Button
                  variant="subtle"
                  size="icon-xs"
                  className="notification-menu-trigger"
                />
              }
              aria-label="Mentions options"
            >
              <EllipsisVertical />
            </MenuTrigger>
            <MenuPopup side="bottom" align="end">
              <MenuItem
                disabled={unreadCount === 0}
                onClick={() => markAllRead.mutate()}
              >
                <MailOpen />
                <span>Mark All as Read</span>
              </MenuItem>
            </MenuPopup>
          </MenuRoot>
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
          <React.Suspense
            fallback={<p className="notification-empty">Loading mentions…</p>}
          >
            <div className="notification-list">
              {items.map((notification) => (
                <NotificationRow
                  key={notification.id}
                  notification={notification}
                  onOpen={openNotification}
                />
              ))}
            </div>
          </React.Suspense>
        )}
      </PopoverContent>
    </PopoverRoot>
  );
}
