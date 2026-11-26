import { defineEndpoint } from "../http/endpoint.js";
import {
  ListNotificationsResponseSchema,
  MarkNotificationsReadRequestSchema,
  MarkNotificationsReadResponseSchema,
  NotificationErrorResponseSchema,
} from "./notifications.js";

/**
 * The inbox's endpoints, which every page loads. Apart from notifications.ts, whose schemas other modules import.
 */

/**
 * Every notification route answers its errors with this one schema: 400
 * for a request it refuses, 503 while persistence or push is unavailable.
 */
const notificationRefusals = [
  { status: 400, schema: NotificationErrorResponseSchema },
  { status: 503, schema: NotificationErrorResponseSchema },
];

export const ListNotificationsEndpoint = defineEndpoint({
  id: "notifications.list",
  summary: "List the person's notifications",
  method: "GET",
  path: "/v1/notifications",
  success: ListNotificationsResponseSchema,
  refusals: notificationRefusals,
});

export const MarkNotificationsReadEndpoint = defineEndpoint({
  id: "notifications.markRead",
  summary: "Mark notifications read",
  method: "POST",
  path: "/v1/notifications/read",
  body: MarkNotificationsReadRequestSchema,
  success: MarkNotificationsReadResponseSchema,
  refusals: notificationRefusals,
});

export const MarkAllNotificationsReadEndpoint = defineEndpoint({
  id: "notifications.markAllRead",
  summary: "Mark every notification read",
  method: "POST",
  path: "/v1/notifications/read-all",
  success: MarkNotificationsReadResponseSchema,
  refusals: notificationRefusals,
});
