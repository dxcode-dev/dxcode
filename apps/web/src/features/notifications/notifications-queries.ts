import type {
  ListNotificationsData,
  NotificationPreferencesData,
  PushStateData,
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
  getPushState,
  listNotifications,
  markAllNotificationsRead,
  markNotificationsRead,
  registerPushDevice,
  removePushDevice,
  sendTestPush,
  updateNotificationPreference,
} from "../../shared/api/client.js";
import {
  readBrowserPushState,
  subscribeThisBrowser,
  unsubscribeThisBrowser,
} from "./push-subscription.js";

export { PushPermissionDenied } from "./push-subscription.js";

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

/**
 * Saves one row. Callers show `variables.enabled` while it is pending, so a
 * failed save falls back to the cached choice with nothing to undo.
 */
export const updateNotificationPreferenceMutationOptions = (
  client: QueryClient,
  userId: UserId,
) =>
  mutationOptions({
    mutationKey: [...notificationKeys.preferences(userId), "update"] as const,
    mutationFn: (input: UpdateNotificationPreferenceRequest) =>
      updateNotificationPreference(input),
    // A read that started before the save must not land after it.
    onMutate: () =>
      client.cancelQueries({ queryKey: notificationKeys.preferences(userId) }),
    onSuccess: (preferences: NotificationPreferencesData) => {
      client.setQueryData(notificationKeys.preferences(userId), preferences);
    },
    // Reread after every save, so neither a rollback nor a late read can
    // leave the switch showing a choice the server does not hold.
    onSettled: () =>
      client.invalidateQueries({
        queryKey: notificationKeys.preferences(userId),
      }),
  });

/**
 * The deployment's push capability and the person's registered devices.
 * Every push mutation answers with this same state, so the cache settles
 * from the response instead of a second read.
 */
export const pushStateQueryOptions = (userId: UserId) =>
  queryOptions({
    queryKey: notificationKeys.push(userId),
    queryFn: ({ signal }) => getPushState(signal),
    staleTime: 30_000,
    gcTime: 5 * 60_000,
  });

/**
 * What this browser knows: whether it can push at all, its permission, and
 * the subscription it holds. It lives in a query because reading it is
 * asynchronous browser state, never a render-time read.
 */
export const browserPushStateQueryOptions = (userId: UserId) =>
  queryOptions({
    queryKey: notificationKeys.pushBrowser(userId),
    queryFn: () => readBrowserPushState(),
    staleTime: 10_000,
    gcTime: 5 * 60_000,
  });

const settlePushState = (
  client: QueryClient,
  userId: UserId,
  state: PushStateData,
) => {
  client.setQueryData(notificationKeys.push(userId), state);
  return client.invalidateQueries({
    queryKey: notificationKeys.pushBrowser(userId),
  });
};

/**
 * Turns push on for this browser: permission, service worker, subscription,
 * then registration with dx. The settings row shows what the browser and the
 * server agree on afterwards, so a half-finished enable never looks done.
 */
export const enablePushMutationOptions = (
  client: QueryClient,
  userId: UserId,
) =>
  mutationOptions({
    mutationKey: [...notificationKeys.push(userId), "enable"] as const,
    mutationFn: async (publicKey: string) =>
      registerPushDevice(await subscribeThisBrowser(publicKey)),
    onSuccess: (state: PushStateData) => settlePushState(client, userId, state),
    onError: () =>
      client.invalidateQueries({
        queryKey: notificationKeys.pushBrowser(userId),
      }),
  });

export const disablePushMutationOptions = (
  client: QueryClient,
  userId: UserId,
) =>
  mutationOptions({
    mutationKey: [...notificationKeys.push(userId), "disable"] as const,
    mutationFn: async () => {
      const subscription = await unsubscribeThisBrowser();
      if (subscription === undefined) return undefined;
      const state = await removePushDevice({
        endpoint: subscription.endpoint,
      });
      await subscription.drop();
      return state;
    },
    onSuccess: (state: PushStateData | undefined) =>
      state === undefined
        ? client.invalidateQueries({ queryKey: notificationKeys.push(userId) })
        : settlePushState(client, userId, state),
    onSettled: () =>
      client.invalidateQueries({
        queryKey: notificationKeys.pushBrowser(userId),
      }),
  });

/** Drops another browser from the person's devices, by its id. */
export const removePushDeviceMutationOptions = (
  client: QueryClient,
  userId: UserId,
) =>
  mutationOptions({
    mutationKey: [...notificationKeys.push(userId), "remove"] as const,
    mutationFn: (deviceId: string) => removePushDevice({ deviceId }),
    onSuccess: (state: PushStateData) => {
      client.setQueryData(notificationKeys.push(userId), state);
    },
  });

/** Sends one push to the person's devices, through the delivery path. */
export const testPushMutationOptions = (userId: UserId) =>
  mutationOptions({
    mutationKey: [...notificationKeys.push(userId), "test"] as const,
    mutationFn: () => sendTestPush(),
  });
