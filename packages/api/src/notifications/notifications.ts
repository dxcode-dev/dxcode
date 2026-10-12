import { ThreadId, UserId } from "@dx/domain";
import { Schema } from "effect";
import { successResponse } from "../http/response.js";

/**
 * What a notification is about. Each topic has its own subscription per
 * delivery channel; the in-app inbox always receives every topic.
 */
export const NotificationTopicSchema = Schema.Literals(["mention"]);

export type NotificationTopic = typeof NotificationTopicSchema.Type;

/**
 * Where a notification is delivered besides the in-app inbox. Each channel is
 * one adapter in Core; a deployment offers only the channels it can deliver.
 */
export const NotificationChannelSchema = Schema.Literals(["email"]);

export type NotificationChannel = typeof NotificationChannelSchema.Type;

export const NotificationIdSchema = Schema.String.check(
  Schema.isPattern(/^ntf_[0-9a-f]{32}$/),
);

export const NotificationActorSchema = Schema.Struct({
  userId: UserId,
  name: Schema.String.check(Schema.isMaxLength(256)),
  handle: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
  image: Schema.optional(Schema.String.check(Schema.isMaxLength(2_048))),
});

export const NotificationDataSchema = Schema.Struct({
  id: NotificationIdSchema,
  topic: NotificationTopicSchema,
  threadId: ThreadId,
  threadTitle: Schema.String.check(Schema.isMaxLength(256)),
  /** The message to open the Thread at (`?message=`), from its author tag. */
  messageId: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
  actor: Schema.optional(NotificationActorSchema),
  excerpt: Schema.String.check(Schema.isMaxLength(512)),
  createdAt: Schema.String,
  readAt: Schema.optional(Schema.String),
});

export type NotificationData = typeof NotificationDataSchema.Type;

/**
 * `GET /v1/notifications`: the newest notifications for Threads the user can
 * still open, and how many of those are unread.
 */
export const ListNotificationsResponseSchema = successResponse(
  Schema.Struct({
    items: Schema.Array(NotificationDataSchema),
    unreadCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
);

export type ListNotificationsData =
  (typeof ListNotificationsResponseSchema.Type)["data"];

/** `POST /v1/notifications/read`: marks the user's own notifications read. */
export const MarkNotificationsReadRequestSchema = Schema.Struct({
  ids: Schema.Array(NotificationIdSchema).check(Schema.isMaxLength(100)),
});

/** `POST /v1/notifications/read` and `/read-all`. */
export const MarkNotificationsReadResponseSchema = successResponse(
  Schema.Struct({
    unreadCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
);

/**
 * One topic on one channel. `available` is false when the deployment cannot
 * deliver on that channel (email needs a sender); the stored choice is kept.
 */
export const NotificationSubscriptionDataSchema = Schema.Struct({
  topic: NotificationTopicSchema,
  channel: NotificationChannelSchema,
  title: Schema.String,
  description: Schema.String,
  enabled: Schema.Boolean,
  available: Schema.Boolean,
});

export type NotificationSubscriptionData =
  typeof NotificationSubscriptionDataSchema.Type;

/** `GET` and `PUT /v1/settings/personal/notifications`. */
export const NotificationPreferencesResponseSchema = successResponse(
  Schema.Struct({
    subscriptions: Schema.Array(NotificationSubscriptionDataSchema),
  }),
);

export type NotificationPreferencesData =
  (typeof NotificationPreferencesResponseSchema.Type)["data"];

export const UpdateNotificationPreferenceRequestSchema = Schema.Struct({
  topic: NotificationTopicSchema,
  channel: NotificationChannelSchema,
  enabled: Schema.Boolean,
});

export type UpdateNotificationPreferenceRequest =
  typeof UpdateNotificationPreferenceRequestSchema.Type;

export const NotificationErrorCode = Schema.Literals([
  "INVALID_REQUEST",
  "PERSISTENCE_UNAVAILABLE",
]);

export type NotificationErrorCode = typeof NotificationErrorCode.Type;

export const NotificationErrorResponseSchema = Schema.Struct({
  status: Schema.Literal("error"),
  data: Schema.Struct({
    code: NotificationErrorCode,
    message: Schema.String,
    requestId: Schema.String,
  }),
});
