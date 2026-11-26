import { defineEndpoint } from "../http/endpoint.js";
import {
  NotificationErrorResponseSchema,
  NotificationPreferencesResponseSchema,
  PushStateResponseSchema,
  RegisterPushDeviceRequestSchema,
  RemovePushDeviceRequestSchema,
  SendTestPushResponseSchema,
  UpdateNotificationPreferenceRequestSchema,
} from "./notifications.js";

/**
 * Notification settings and push devices, which only Settings calls: apart from the inbox, so they stay off the first load.
 */

/**
 * Every notification route answers its errors with this one schema: 400
 * for a request it refuses, 503 while persistence or push is unavailable.
 */
const notificationRefusals = [
  { status: 400, schema: NotificationErrorResponseSchema },
  { status: 503, schema: NotificationErrorResponseSchema },
];

export const GetNotificationPreferencesEndpoint = defineEndpoint({
  id: "notifications.getPreferences",
  summary: "Read notification preferences",
  method: "GET",
  path: "/v1/settings/personal/notifications",
  success: NotificationPreferencesResponseSchema,
  refusals: notificationRefusals,
});

export const UpdateNotificationPreferenceEndpoint = defineEndpoint({
  id: "notifications.updatePreference",
  summary: "Change a notification preference",
  method: "PUT",
  path: "/v1/settings/personal/notifications",
  body: UpdateNotificationPreferenceRequestSchema,
  success: NotificationPreferencesResponseSchema,
  refusals: notificationRefusals,
});

export const GetPushStateEndpoint = defineEndpoint({
  id: "notifications.getPush",
  summary: "Read push notification settings and devices",
  method: "GET",
  path: "/v1/notifications/push",
  success: PushStateResponseSchema,
  refusals: notificationRefusals,
});

export const RegisterPushDeviceEndpoint = defineEndpoint({
  id: "notifications.registerPushDevice",
  summary: "Register a device for push notifications",
  method: "POST",
  path: "/v1/notifications/push/devices",
  body: RegisterPushDeviceRequestSchema,
  success: PushStateResponseSchema,
  refusals: notificationRefusals,
});

export const RemovePushDeviceEndpoint = defineEndpoint({
  id: "notifications.removePushDevice",
  summary: "Remove a push notification device",
  method: "DELETE",
  path: "/v1/notifications/push/devices",
  body: RemovePushDeviceRequestSchema,
  success: PushStateResponseSchema,
  refusals: notificationRefusals,
});

export const SendTestPushEndpoint = defineEndpoint({
  id: "notifications.sendTestPush",
  summary: "Send a test push notification",
  method: "POST",
  path: "/v1/notifications/push/test",
  success: SendTestPushResponseSchema,
  refusals: notificationRefusals,
});
