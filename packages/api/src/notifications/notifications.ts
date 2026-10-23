import { ThreadId, UserId } from "@dx/domain";
import { Schema } from "effect";
import { successResponse } from "../http/response.js";

/**
 * What a notification is about. A topic offers its own channels — only
 * mentions reach a person by email — and decides whether it reaches the
 * in-app Mentions inbox, which only mentions do.
 */
export const NotificationTopicSchema = Schema.Literals([
  "mention",
  "turn_completed",
  "snooze_woke",
]);

export type NotificationTopic = typeof NotificationTopicSchema.Type;

/**
 * Where a notification is delivered besides the in-app inbox. Each channel is
 * one adapter in Core; a deployment offers only the channels it can deliver.
 */
export const NotificationChannelSchema = Schema.Literals(["email", "push"]);

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

/** Base64url, as a browser's `PushSubscription` keys are encoded. */
const Base64Url = (maxLength: number) =>
  Schema.String.check(
    Schema.isMaxLength(maxLength),
    Schema.isPattern(/^[A-Za-z0-9_-]+$/),
  );

/**
 * The push endpoint a browser's push service issued. It is the device's
 * address and its secret: anyone holding it can wake that browser. Browsers
 * only ever issue `https:` endpoints; a loopback `http:` one is admitted so
 * local development can stand in for a push service, and Core refuses it
 * outside a local runtime.
 */
const PushEndpointSchema = Schema.String.check(
  Schema.isMaxLength(2_048),
  Schema.isPattern(
    /^(?:https:\/\/|http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\/)[^\s"'<>]+$/,
  ),
);

/**
 * One browser that accepted push notifications. The endpoint itself never
 * leaves Core — it can wake that browser — so a device is identified to its
 * owner by the SHA-256 of the endpoint, which the browser recomputes to
 * recognise itself among its person's devices.
 */
export const PushDeviceDataSchema = Schema.Struct({
  id: Schema.String,
  /** "Chrome on macOS", from the browser that registered. */
  label: Schema.String.check(Schema.isMaxLength(128)),
  endpointHash: Schema.String.check(Schema.isMaxLength(64)),
  createdAt: Schema.String,
  lastDeliveredAt: Schema.optional(Schema.String),
});

export type PushDeviceData = typeof PushDeviceDataSchema.Type;

/**
 * `GET /v1/notifications/push`, and the answer to every push device change:
 * whether the deployment can push, the VAPID public key a browser subscribes
 * with, and the person's registered devices.
 */
export const PushStateResponseSchema = successResponse(
  Schema.Struct({
    available: Schema.Boolean,
    publicKey: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
    devices: Schema.Array(PushDeviceDataSchema),
  }),
);

export type PushStateData = (typeof PushStateResponseSchema.Type)["data"];

/** `POST /v1/notifications/push/devices`: a browser's `PushSubscription`. */
export const RegisterPushDeviceRequestSchema = Schema.Struct({
  endpoint: PushEndpointSchema,
  keys: Schema.Struct({
    /** The device's ECDH P-256 public key (65 bytes). */
    p256dh: Base64Url(128),
    /** The device's 16-byte authentication secret. */
    auth: Base64Url(64),
  }),
  label: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
});

export type RegisterPushDeviceRequest =
  typeof RegisterPushDeviceRequestSchema.Type;

/**
 * `DELETE /v1/notifications/push/devices`: a device stops receiving. The
 * browser names its own by endpoint; any other device is named by the id
 * the device list shows, so a lost phone can be dropped from a laptop.
 */
export const RemovePushDeviceRequestSchema = Schema.Struct({
  endpoint: Schema.optional(PushEndpointSchema),
  deviceId: Schema.optional(
    Schema.String.check(Schema.isPattern(/^psb_[0-9a-f]{32}$/)),
  ),
});

export type RemovePushDeviceRequest = typeof RemovePushDeviceRequestSchema.Type;

/** `POST /v1/notifications/push/test`: one push to the person's devices. */
export const SendTestPushResponseSchema = successResponse(
  Schema.Struct({
    delivered: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    failed: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
);

export type SendTestPushData = (typeof SendTestPushResponseSchema.Type)["data"];

/**
 * What a push message carries to the service worker. It is encrypted to the
 * device (RFC 8291), so the push service never reads it.
 */
export const PushPayloadSchema = Schema.Struct({
  title: Schema.String,
  body: Schema.String,
  /** Same-origin path the notification opens. */
  url: Schema.String,
  topic: Schema.String,
  /** Collapses repeats of the same event on the device. */
  tag: Schema.String,
});

export type PushPayload = typeof PushPayloadSchema.Type;

export const NotificationErrorCode = Schema.Literals([
  "INVALID_REQUEST",
  "PERSISTENCE_UNAVAILABLE",
  "PUSH_UNAVAILABLE",
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
