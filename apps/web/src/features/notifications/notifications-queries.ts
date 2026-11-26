import {
  type ListNotificationsData,
  ListNotificationsEndpoint,
  MarkAllNotificationsReadEndpoint,
  MarkNotificationsReadEndpoint,
} from "@dx/api";
import type { UserId } from "@dx/domain";
import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { dxClient } from "../../shared/api/client.js";

export const notificationKeys = {
  all: (userId: UserId) => ["notifications", userId] as const,
  inbox: (userId: UserId) => ["notifications", userId, "inbox"] as const,
  preferences: (userId: UserId) =>
    ["notifications", userId, "preferences"] as const,
  push: (userId: UserId) => ["notifications", userId, "push"] as const,
  pushBrowser: (userId: UserId) =>
    ["notifications", userId, "push", "browser"] as const,
};

/**
 * The inbox. Realtime `notifications.invalidated` refetches it at once; the
 * interval is the fallback while the socket is down.
 */
export const notificationInboxQueryOptions = (userId: UserId) =>
  queryOptions({
    queryKey: notificationKeys.inbox(userId),
    queryFn: async ({ signal }) =>
      (await dxClient.call(ListNotificationsEndpoint, {}, { signal })).data,
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
    mutationFn: async (ids: ReadonlyArray<string>) =>
      (await dxClient.call(MarkNotificationsReadEndpoint, { body: { ids } }))
        .data,
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
    mutationFn: async () =>
      (await dxClient.call(MarkAllNotificationsReadEndpoint)).data,
    onMutate: async () => {
      await client.cancelQueries({ queryKey: notificationKeys.inbox(userId) });
      markReadLocally(client, userId, "all");
    },
    onSuccess: ({ unreadCount }) =>
      settleUnreadCount(client, userId, unreadCount),
    onError: () => invalidateNotifications(client, userId),
  });
