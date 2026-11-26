import {
  GetNotificationPreferencesEndpoint,
  GetPushStateEndpoint,
  type NotificationPreferencesData,
  type PushStateData,
  RegisterPushDeviceEndpoint,
  RemovePushDeviceEndpoint,
  SendTestPushEndpoint,
  UpdateNotificationPreferenceEndpoint,
  type UpdateNotificationPreferenceRequest,
} from "@dx/api";
import type { UserId } from "@dx/domain";
import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { dxClient } from "../../shared/api/client.js";
import { notificationKeys } from "./notifications-queries.js";
import {
  readBrowserPushState,
  subscribeThisBrowser,
  unsubscribeThisBrowser,
} from "./push-subscription.js";

/**
 * Notification settings and push devices, which only Settings reads: kept
 * apart from the inbox so they load with Settings, not on every page.
 */

export { PushPermissionDenied } from "./push-subscription.js";

export const notificationPreferencesQueryOptions = (userId: UserId) =>
  queryOptions({
    queryKey: notificationKeys.preferences(userId),
    queryFn: async ({ signal }) =>
      (await dxClient.call(GetNotificationPreferencesEndpoint, {}, { signal }))
        .data,
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
    mutationFn: async (input: UpdateNotificationPreferenceRequest) =>
      (
        await dxClient.call(UpdateNotificationPreferenceEndpoint, {
          body: input,
        })
      ).data,
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
    queryFn: async ({ signal }) =>
      (await dxClient.call(GetPushStateEndpoint, {}, { signal })).data,
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
      (
        await dxClient.call(RegisterPushDeviceEndpoint, {
          body: await subscribeThisBrowser(publicKey),
        })
      ).data,
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
      const { data: state } = await dxClient.call(RemovePushDeviceEndpoint, {
        body: { endpoint: subscription.endpoint },
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
    mutationFn: async (deviceId: string) =>
      (await dxClient.call(RemovePushDeviceEndpoint, { body: { deviceId } }))
        .data,
    onSuccess: (state: PushStateData) => {
      client.setQueryData(notificationKeys.push(userId), state);
    },
  });

/** Sends one push to the person's devices, through the delivery path. */
export const testPushMutationOptions = (userId: UserId) =>
  mutationOptions({
    mutationKey: [...notificationKeys.push(userId), "test"] as const,
    mutationFn: async () => (await dxClient.call(SendTestPushEndpoint)).data,
  });
