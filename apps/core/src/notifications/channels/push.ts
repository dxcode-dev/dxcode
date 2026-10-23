import type { PushPayload } from "@dx/api";
import type { UserId } from "@dx/domain";
import { notificationLogger } from "../../logging.js";
import {
  forgetPushSubscription,
  pushTargets,
  recordPushDelivery,
} from "../push-devices.js";
import {
  type ChannelDelivery,
  ChannelDeliveryError,
  ChannelNotReachable,
  type NotificationChannel,
} from "./channel.js";
import {
  PUSH_PAYLOAD_LIMIT,
  sendPushMessage,
  type VapidKeys,
} from "./web-push.js";

const capitalized = (value: string) =>
  `${value.at(0)?.toUpperCase() ?? ""}${value.slice(1)}`;

/** Leaves room for the JSON around the text inside one 4 KB record. */
const BODY_LIMIT = 500;

const bounded = (value: string, limit: number) =>
  value.length <= limit ? value : `${value.slice(0, limit - 1).trimEnd()}…`;

/**
 * What one notification looks like on a device. The tag is per Thread and
 * topic, so a Thread's newest update replaces its previous one instead of
 * stacking.
 */
export const pushPayload = (
  delivery: ChannelDelivery,
  topic: string,
  threadId: string,
): PushPayload => ({
  title: bounded(delivery.content.subject, 120),
  body: bounded(delivery.content.body, BODY_LIMIT),
  url: delivery.links.open,
  topic,
  tag: `${topic}:${threadId}`,
});

export interface PushChannelContext {
  readonly db: D1Database;
  readonly keys: VapidKeys;
  /** VAPID `sub`: the deployment's own origin. */
  readonly subject: string;
}

/**
 * Web push to every browser the recipient registered (RFC 8030/8291/8292,
 * encrypted in `web-push.ts`). The deployment needs a VAPID key pair; a
 * recipient needs at least one device, and a device a push service accepted.
 *
 * A push service that reports a subscription gone (404 or 410) has it
 * dropped, so a stale browser stops being retried. One device failing does
 * not fail the others: the delivery counts as sent when any device took it.
 */
export const pushChannel = (
  context: PushChannelContext | undefined,
): NotificationChannel => ({
  id: "push",
  subscriptionTitle: (topicNoun) => `${capitalized(topicNoun)} push`,
  subscriptionDescription: (trigger) =>
    `Send a push notification to your devices when ${trigger}.`,
  available: context !== undefined,
  deliver: async (delivery) => {
    if (context === undefined) throw new ChannelDeliveryError("unavailable");
    await deliverPush(
      context,
      delivery.recipient.userId,
      pushPayload(delivery, delivery.topic, delivery.threadId),
    );
  },
});

/**
 * Sends one payload to all of a person's devices. Shared by the channel and
 * by the settings "Send a test" button, so both prove the same path.
 */
export const deliverPush = async (
  context: PushChannelContext,
  userId: UserId,
  payload: PushPayload,
): Promise<{ readonly delivered: number; readonly failed: number }> => {
  const targets = await pushTargets(context.db, userId);
  if (targets.length === 0) throw new ChannelNotReachable("no push device");
  const message = JSON.stringify(payload);
  if (message.length > PUSH_PAYLOAD_LIMIT)
    throw new ChannelDeliveryError("payload_too_long");
  const results = await Promise.all(
    targets.map(async (target) => {
      const result = await sendPushMessage(context.keys, target, message, {
        subject: context.subject,
      });
      if (result.status === "expired") {
        await forgetPushSubscription(context.db, target.endpoint).catch(
          (cause) =>
            notificationLogger.warn("Expired push device was not removed.", {
              event: "push_device_cleanup_failed",
              cause,
            }),
        );
        return { endpoint: target.endpoint, result };
      }
      if (result.status === "failed")
        notificationLogger.warn("Push delivery failed.", {
          event: "push_delivery_failed",
          code: result.code,
        });
      return { endpoint: target.endpoint, result };
    }),
  );
  const sent = results.filter(({ result }) => result.status === "sent");
  await recordPushDelivery(
    context.db,
    sent.map(({ endpoint }) => endpoint),
  ).catch((cause) =>
    notificationLogger.warn("Push delivery was not recorded on the device.", {
      event: "push_device_record_failed",
      cause,
    }),
  );
  const outcome = {
    delivered: sent.length,
    failed: results.length - sent.length,
  };
  if (outcome.delivered === 0) {
    // Every device is gone: the person has no push address left, which is
    // not a delivery failure worth recording against the notification.
    if (results.every(({ result }) => result.status === "expired"))
      throw new ChannelNotReachable("every push device expired");
    throw new ChannelDeliveryError("push_send_failed");
  }
  return outcome;
};
