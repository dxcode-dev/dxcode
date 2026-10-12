import type {
  ListNotificationsData,
  NotificationPreferencesData,
  UpdateNotificationPreferenceRequest,
} from "@dx/api";
import type { UserId } from "@dx/domain";
import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import {
  getNotificationPreferences,
  listNotifications,
  markAllNotificationsRead,
  markNotificationsRead,
  updateNotificationPreference,
} from "../../shared/api/client.js";

export const notificationKeys = {
  all: (userId: UserId) => ["notifications", userId] as const,
  inbox: (userId: UserId) => ["notifications", userId, "inbox"] as const,
  preferences: (userId: UserId) =>
    ["notifications", userId, "preferences"] as const,
};

/**
 * The inbox. Realtime `notifications.invalidated` refetches it at once; the
 * interval is the fallback while the socket is down.
 */
export const notificationInboxQueryOptions = (userId: UserId) =>
  queryOptions({
    queryKey: notificationKeys.inbox(userId),
    queryFn: ({ signal }) => listNotifications(signal),
    staleTime: 30_000,
    gcTime: 10 * 60_000,
    refetchInterval: 120_000,
    refetchOnWindowFocus: true,
  });

export const invalidateNotifications = (client: QueryClient, userId: UserId) =>
  client.invalidateQueries({ queryKey: notificationKeys.inbox(userId) });

const markReadLocally = (
  client: QueryClient,
  userId: UserId,
  ids: ReadonlySet<string> | "all",
) => {
  const readAt = new Date().toISOString();
  client.setQueryData<ListNotificationsData>(
    notificationKeys.inbox(userId),
    (current) => {
      if (current === undefined) return current;
      const items = current.items.map((item) =>
        item.readAt === undefined && (ids === "all" || ids.has(item.id))
          ? { ...item, readAt }
          : item,
      );
      const marked =
        current.items.filter((item) => item.readAt === undefined).length -
        items.filter((item) => item.readAt === undefined).length;
      return {
        items,
        unreadCount: Math.max(0, current.unreadCount - marked),
      };
    },
  );
};

const settleUnreadCount = (
  client: QueryClient,
  userId: UserId,
  unreadCount: number,
) =>
  client.setQueryData<ListNotificationsData>(
    notificationKeys.inbox(userId),
    (current) =>
      current === undefined ? current : { ...current, unreadCount },
  );

export const markNotificationsReadMutationOptions = (
  client: QueryClient,
  userId: UserId,
) =>
  mutationOptions({
    mutationKey: [...notificationKeys.inbox(userId), "read"] as const,
    mutationFn: (ids: ReadonlyArray<string>) => markNotificationsRead(ids),
    onMutate: async (ids) => {
      await client.cancelQueries({ queryKey: notificationKeys.inbox(userId) });
      markReadLocally(client, userId, new Set(ids));
    },
    onSuccess: ({ unreadCount }) =>
      settleUnreadCount(client, userId, unreadCount),
    onError: () => invalidateNotifications(client, userId),
  });

export const markAllNotificationsReadMutationOptions = (
  client: QueryClient,
  userId: UserId,
) =>
  mutationOptions({
    mutationKey: [...notificationKeys.inbox(userId), "read-all"] as const,
    mutationFn: () => markAllNotificationsRead(),
    onMutate: async () => {
      await client.cancelQueries({ queryKey: notificationKeys.inbox(userId) });
      markReadLocally(client, userId, "all");
    },
    onSuccess: ({ unreadCount }) =>
      settleUnreadCount(client, userId, unreadCount),
    onError: () => invalidateNotifications(client, userId),
  });

export const notificationPreferencesQueryOptions = (userId: UserId) =>
  queryOptions({
    queryKey: notificationKeys.preferences(userId),
    queryFn: ({ signal }) => getNotificationPreferences(signal),
    staleTime: 30_000,
    gcTime: 5 * 60_000,
  });

export const updateNotificationPreferenceMutationOptions = (
  client: QueryClient,
  userId: UserId,
) =>
  mutationOptions({
    mutationKey: [...notificationKeys.preferences(userId), "update"] as const,
    mutationFn: (input: UpdateNotificationPreferenceRequest) =>
      updateNotificationPreference(input),
    onSuccess: (preferences: NotificationPreferencesData) => {
      client.setQueryData(notificationKeys.preferences(userId), preferences);
    },
  });
