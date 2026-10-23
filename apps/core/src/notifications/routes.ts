import {
  ListNotificationsResponseSchema,
  MarkNotificationsReadRequestSchema,
  MarkNotificationsReadResponseSchema,
  type NotificationErrorCode,
  NotificationErrorResponseSchema,
  NotificationPreferencesResponseSchema,
  type NotificationSubscriptionData,
  PushStateResponseSchema,
  RegisterPushDeviceRequestSchema,
  RemovePushDeviceRequestSchema,
  SendTestPushResponseSchema,
  UpdateNotificationPreferenceRequestSchema,
} from "@dx/api";
import type { UserId } from "@dx/domain";
import { Option, Schema } from "effect";
import { type Context, Hono } from "hono";
import type { AppEnv, Bindings } from "../http/types.js";
import { notificationLogger } from "../logging.js";
import { publishNotificationsInvalidation } from "../realtime/publication.js";
import { ChannelNotReachable } from "./channels/channel.js";
import { deploymentVapidKeys, notificationChannels } from "./channels/index.js";
import { deliverPush, type PushChannelContext } from "./channels/push.js";
import { subscribed } from "./publish.js";
import {
  listPushDevices,
  registerPushSubscription,
  removePushSubscription,
} from "./push-devices.js";
import {
  listNotifications,
  markNotificationsRead,
  notificationPreferences,
  setNotificationPreference,
  unreadNotificationCount,
} from "./repository.js";
import { NOTIFICATION_TOPICS, topicOffersChannel } from "./topics.js";
import { verifyUnsubscribeToken } from "./unsubscribe-token.js";

const failure = (
  context: Context<AppEnv>,
  code: NotificationErrorCode,
  status: 400 | 503,
  message: string,
) =>
  context.json(
    Schema.encodeUnknownSync(NotificationErrorResponseSchema)({
      status: "error",
      data: { code, message, requestId: context.get("requestId") },
    }),
    status,
  );

const handle = async (
  context: Context<AppEnv>,
  run: (db: D1Database, userId: UserId) => Promise<Response>,
) => {
  const db = context.env.DB;
  if (db === undefined)
    return failure(
      context,
      "PERSISTENCE_UNAVAILABLE",
      503,
      "Persistence is temporarily unavailable.",
    );
  try {
    return await run(db, context.get("principal").userId as UserId);
  } catch (cause) {
    notificationLogger.error("Notification request failed.", {
      event: "notification_request_failed",
      requestId: context.get("requestId"),
      cause,
    });
    return failure(
      context,
      "PERSISTENCE_UNAVAILABLE",
      503,
      "Persistence is temporarily unavailable.",
    );
  }
};

const readResponse = async (
  context: Context<AppEnv>,
  db: D1Database,
  userId: UserId,
) => {
  await publishNotificationsInvalidation(context.env, userId);
  return context.json(
    Schema.encodeUnknownSync(MarkNotificationsReadResponseSchema)({
      status: "success",
      data: { unreadCount: await unreadNotificationCount(db, userId) },
    }),
    200,
  );
};

/** The push channel's dependencies, or undefined when it cannot deliver. */
const pushContext = (bindings: Bindings): PushChannelContext | undefined => {
  const keys = deploymentVapidKeys(bindings);
  const origin = bindings.DX_AUTH_URL?.trim().replace(/\/+$/, "");
  return keys === undefined || bindings.DB === undefined || !origin
    ? undefined
    : { db: bindings.DB, keys, subject: origin };
};

const pushStateResponse = async (
  context: Context<AppEnv>,
  db: D1Database,
  userId: UserId,
) => {
  const keys = deploymentVapidKeys(context.env);
  return context.json(
    Schema.encodeUnknownSync(PushStateResponseSchema)({
      status: "success",
      data: {
        available: pushContext(context.env) !== undefined,
        ...(keys === undefined ? {} : { publicKey: keys.publicKey }),
        devices: await listPushDevices(db, userId),
      },
    }),
    200,
  );
};

/** Mounted at `/v1/notifications`: the signed-in person's inbox. */
export const notificationRoutes = new Hono<AppEnv>()
  .get("/", (context) =>
    handle(context, async (db, userId) => {
      const [items, unreadCount] = await Promise.all([
        listNotifications(db, userId),
        unreadNotificationCount(db, userId),
      ]);
      return context.json(
        Schema.encodeUnknownSync(ListNotificationsResponseSchema)({
          status: "success",
          data: { items, unreadCount },
        }),
        200,
      );
    }),
  )
  .post("/read", (context) =>
    handle(context, async (db, userId) => {
      const body = Schema.decodeUnknownOption(
        MarkNotificationsReadRequestSchema,
      )(await context.req.json().catch(() => undefined));
      if (Option.isNone(body))
        return failure(
          context,
          "INVALID_REQUEST",
          400,
          "Request validation failed.",
        );
      await markNotificationsRead(db, userId, body.value.ids);
      return readResponse(context, db, userId);
    }),
  )
  .post("/read-all", (context) =>
    handle(context, async (db, userId) => {
      await markNotificationsRead(db, userId, "all");
      return readResponse(context, db, userId);
    }),
  )
  .get("/push", (context) =>
    handle(context, (db, userId) => pushStateResponse(context, db, userId)),
  )
  /**
   * Registers this browser's `PushSubscription`. Repeating it is how a
   * browser refreshes keys its push service rotated.
   */
  .post("/push/devices", (context) =>
    handle(context, async (db, userId) => {
      const body = Schema.decodeUnknownOption(RegisterPushDeviceRequestSchema)(
        await context.req.json().catch(() => undefined),
      );
      if (Option.isNone(body))
        return failure(
          context,
          "INVALID_REQUEST",
          400,
          "Request validation failed.",
        );
      if (pushContext(context.env) === undefined)
        return failure(
          context,
          "PUSH_UNAVAILABLE",
          503,
          "This deployment cannot send push notifications.",
        );
      // A browser issues an https endpoint; a loopback one belongs to a
      // local push service, which only local development ever has.
      if (
        !body.value.endpoint.startsWith("https://") &&
        context.env.DX_RUNTIME_MODE !== "local"
      )
        return failure(
          context,
          "INVALID_REQUEST",
          400,
          "Request validation failed.",
        );
      await registerPushSubscription(db, {
        userId,
        endpoint: body.value.endpoint,
        p256dh: body.value.keys.p256dh,
        auth: body.value.keys.auth,
        label: body.value.label ?? "",
      });
      notificationLogger.info("Push device registered.", {
        event: "push_device_registered",
      });
      return pushStateResponse(context, db, userId);
    }),
  )
  .delete("/push/devices", (context) =>
    handle(context, async (db, userId) => {
      const body = Schema.decodeUnknownOption(RemovePushDeviceRequestSchema)(
        await context.req.json().catch(() => undefined),
      );
      if (Option.isNone(body))
        return failure(
          context,
          "INVALID_REQUEST",
          400,
          "Request validation failed.",
        );
      if (
        body.value.endpoint === undefined &&
        body.value.deviceId === undefined
      )
        return failure(
          context,
          "INVALID_REQUEST",
          400,
          "Request validation failed.",
        );
      await removePushSubscription(db, userId, body.value);
      return pushStateResponse(context, db, userId);
    }),
  )
  /** Sends one push through the same path a notification takes. */
  .post("/push/test", (context) =>
    handle(context, async (_db, userId) => {
      const push = pushContext(context.env);
      if (push === undefined)
        return failure(
          context,
          "PUSH_UNAVAILABLE",
          503,
          "This deployment cannot send push notifications.",
        );
      const outcome = await deliverPush(push, userId, {
        title: "dx push notifications are on",
        body: "This is how a mention or a finished turn will reach you.",
        url: `${push.subject}/settings/notifications`,
        topic: "test",
        tag: "test",
      }).catch((cause) =>
        cause instanceof ChannelNotReachable
          ? { delivered: 0, failed: 0 }
          : { delivered: 0, failed: 1 },
      );
      return context.json(
        Schema.encodeUnknownSync(SendTestPushResponseSchema)({
          status: "success",
          data: outcome,
        }),
        200,
      );
    }),
  );

const subscriptions = async (
  db: D1Database,
  bindings: Bindings,
  userId: UserId,
): Promise<ReadonlyArray<NotificationSubscriptionData>> => {
  const preferences = await notificationPreferences(db, [userId]);
  const channels = Object.values(notificationChannels(bindings));
  // Only the pairs a topic offers: an agent update or a woken Thread is a
  // nudge, not mail.
  return Object.values(NOTIFICATION_TOPICS).flatMap((topic) =>
    channels
      .filter((channel) => topicOffersChannel(topic, channel.id))
      .map((channel) => ({
        topic: topic.id,
        channel: channel.id,
        title: channel.subscriptionTitle(topic.noun),
        description: channel.subscriptionDescription(topic.trigger),
        enabled: subscribed(preferences, userId, topic.id, channel.id),
        available: channel.available,
      })),
  );
};

const preferencesResponse = async (
  context: Context<AppEnv>,
  db: D1Database,
  userId: UserId,
) =>
  context.json(
    Schema.encodeUnknownSync(NotificationPreferencesResponseSchema)({
      status: "success",
      data: { subscriptions: await subscriptions(db, context.env, userId) },
    }),
    200,
  );

/**
 * Mounted at `/v1/settings/personal/notifications`: which topics reach the
 * person on which channels.
 */
export const notificationPreferenceRoutes = new Hono<AppEnv>()
  .get("/", (context) =>
    handle(context, (db, userId) => preferencesResponse(context, db, userId)),
  )
  .put("/", (context) =>
    handle(context, async (db, userId) => {
      const body = Schema.decodeUnknownOption(
        UpdateNotificationPreferenceRequestSchema,
      )(await context.req.json().catch(() => undefined));
      if (Option.isNone(body))
        return failure(
          context,
          "INVALID_REQUEST",
          400,
          "Request validation failed.",
        );
      // A topic that does not offer the channel has no such choice to make.
      if (
        !topicOffersChannel(
          NOTIFICATION_TOPICS[body.value.topic],
          body.value.channel,
        )
      )
        return failure(
          context,
          "INVALID_REQUEST",
          400,
          "Request validation failed.",
        );
      await setNotificationPreference(db, { userId, ...body.value });
      return preferencesResponse(context, db, userId);
    }),
  );

const page = (heading: string, body: string, form?: string) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>${heading} · dx</title>
  </head>
  <body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;background:#f5f5f4;color:#14171a;">
    <main style="max-width:420px;margin:72px auto;padding:32px;background:#ffffff;border:1px solid #e7e5e4;border-radius:12px;">
      <div style="font-size:22px;font-weight:700;letter-spacing:-0.03em;padding-bottom:20px;">dx</div>
      <h1 style="font-size:18px;margin:0 0 8px;">${heading}</h1>
      <p style="font-size:14px;line-height:22px;color:#55595e;margin:0 0 20px;">${body}</p>
      ${form ?? ""}
    </main>
  </body>
</html>`;

const invalidLink = (context: Context<AppEnv>) =>
  context.html(
    page(
      "This link is not valid",
      "Change which emails you receive in dx under Settings, Notifications.",
    ),
    400,
  );

/**
 * Mounted at `/api/notifications/unsubscribe`, without sign-in. Opening the
 * link only asks, so mail scanners that follow links change nothing; the
 * button and RFC 8058 one-click (`List-Unsubscribe-Post`) send the POST.
 */
export const notificationUnsubscribeRoutes = new Hono<AppEnv>()
  .get("/", async (context) => {
    const secret = context.env.BETTER_AUTH_SECRET;
    const token = context.req.query("token") ?? "";
    const grant =
      secret === undefined
        ? undefined
        : await verifyUnsubscribeToken(secret, token);
    if (grant === undefined) return invalidLink(context);
    const noun = NOTIFICATION_TOPICS[grant.topic].noun;
    return context.html(
      page(
        `Unsubscribe from ${noun} emails?`,
        `You will still see ${noun}s in dx. You can turn these emails back on in Settings, Notifications.`,
        `<form method="post" action="?token=${encodeURIComponent(token)}">
        <button type="submit" style="font:inherit;font-size:14px;font-weight:600;color:#ffffff;background:#14171a;border:0;border-radius:8px;padding:10px 18px;cursor:pointer;">Unsubscribe</button>
      </form>`,
      ),
    );
  })
  .post("/", async (context) => {
    const db = context.env.DB;
    const secret = context.env.BETTER_AUTH_SECRET;
    const grant =
      secret === undefined
        ? undefined
        : await verifyUnsubscribeToken(
            secret,
            context.req.query("token") ?? "",
          );
    if (grant === undefined || db === undefined) return invalidLink(context);
    await setNotificationPreference(db, { ...grant, enabled: false });
    notificationLogger.info("Notification channel unsubscribed.", {
      event: "notification_unsubscribed",
      topic: grant.topic,
      channel: grant.channel,
    });
    const noun = NOTIFICATION_TOPICS[grant.topic].noun;
    return context.html(
      page(
        "You're unsubscribed",
        `dx will no longer email you about ${noun}s. You can turn these emails back on in Settings, Notifications.`,
      ),
    );
  });
