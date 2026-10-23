import type { NotificationChannel, NotificationTopic } from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import type { Bindings } from "../http/types.js";
import { notificationLogger } from "../logging.js";
import { publishNotificationsInvalidation } from "../realtime/publication.js";
import { userIdentity } from "../thread-sharing/service.js";
import {
  ChannelDeliveryError,
  ChannelNotReachable,
} from "./channels/channel.js";
import { notificationChannels } from "./channels/index.js";
import {
  insertNotifications,
  notificationPreferences,
  preferenceKey,
  recipientContacts,
  recordDelivery,
  threadTitle,
} from "./repository.js";
import { NOTIFICATION_TOPICS } from "./topics.js";
import { signUnsubscribeToken } from "./unsubscribe-token.js";

/** Something happened in a Thread that concerns some people. */
export interface NotificationEvent {
  readonly topic: NotificationTopic;
  /** Names the event; each recipient is notified once per key. */
  readonly sourceKey: string;
  readonly recipients: ReadonlyArray<UserId>;
  readonly threadId: ThreadId;
  /** The message to open the Thread at. */
  readonly messageId?: string;
  readonly actorUserId?: UserId;
  /** What was said, as plain text. */
  readonly excerpt: string;
}

const EXCERPT_LENGTH = 280;

const excerptOf = (text: string) => {
  const trimmed = text.trim();
  return trimmed.length <= EXCERPT_LENGTH
    ? trimmed
    : `${trimmed.slice(0, EXCERPT_LENGTH - 1).trimEnd()}…`;
};

/**
 * Whether a person receives a topic on a channel: their choice, else the
 * topic's default. A topic that does not offer the channel is never
 * delivered on it, whatever is stored.
 */
export const subscribed = (
  preferences: ReadonlyMap<string, boolean>,
  userId: UserId,
  topic: NotificationTopic,
  channel: NotificationChannel,
) => {
  const fallback = NOTIFICATION_TOPICS[topic].defaults[channel];
  if (fallback === undefined) return false;
  return preferences.get(preferenceKey(userId, topic, channel)) ?? fallback;
};

/**
 * Notifies people: records each recipient's inbox row, tells their open apps
 * to refresh, then delivers on every channel the deployment offers and the
 * recipient subscribes to and records each delivery's outcome. Recipients
 * who already have the event are skipped, so a retry notifies once. A failed
 * channel never fails the inbox or other channels.
 */
export const publishNotification = async (
  bindings: Bindings,
  event: NotificationEvent,
) => {
  const db = bindings.DB;
  if (db === undefined) return;
  const recipients = [...new Set(event.recipients)].filter(
    (userId) => userId !== event.actorUserId,
  );
  const excerpt = excerptOf(event.excerpt);
  const created = await insertNotifications(db, {
    ...event,
    recipients,
    excerpt,
  });
  if (created.length === 0) return;
  const userIds = created.map(({ recipientUserId }) => recipientUserId);
  // The inbox is the source of truth: refresh open apps before any channel
  // runs, so a slow or failing channel never delays or hides the badge.
  await Promise.all(
    userIds.map((userId) => publishNotificationsInvalidation(bindings, userId)),
  );
  const channels = Object.values(notificationChannels(bindings)).filter(
    (channel) => channel.available,
  );
  const origin = bindings.DX_AUTH_URL?.trim().replace(/\/+$/, "");
  const secret = bindings.BETTER_AUTH_SECRET;
  if (channels.length === 0 || !origin || secret === undefined) return;
  const topic = NOTIFICATION_TOPICS[event.topic];
  const [preferences, contacts, title, actor] = await Promise.all([
    notificationPreferences(db, userIds),
    recipientContacts(db, userIds),
    threadTitle(db, event.threadId),
    event.actorUserId === undefined
      ? Promise.resolve({ name: "Someone" })
      : userIdentity(db, event.actorUserId),
  ]);
  const content = topic.content({
    actorName: actor.name,
    threadTitle: title,
    excerpt,
  });
  const open = `${origin}/threads/${encodeURIComponent(event.threadId)}${
    event.messageId === undefined
      ? ""
      : `?message=${encodeURIComponent(event.messageId)}`
  }`;
  await Promise.all(
    created.flatMap(({ id, recipientUserId }) =>
      channels.map(async (channel) => {
        const recipient = contacts.get(recipientUserId);
        if (
          recipient === undefined ||
          !subscribed(preferences, recipientUserId, topic.id, channel.id)
        )
          return;
        const token = await signUnsubscribeToken(secret, {
          userId: recipientUserId,
          topic: topic.id,
          channel: channel.id,
        });
        // Decide the outcome from delivery alone; recording it is separate,
        // so a failed write never relabels a sent message as failed.
        let outcome: { status: "sent" } | { status: "failed"; error: string };
        try {
          await channel.deliver({
            recipient: { userId: recipientUserId, ...recipient },
            content,
            topic: topic.id,
            threadId: event.threadId,
            topicNoun: topic.noun,
            links: {
              open,
              unsubscribe: `${origin}/api/notifications/unsubscribe?token=${encodeURIComponent(token)}`,
            },
          });
          outcome = { status: "sent" };
        } catch (cause) {
          // Nothing was tried: the person has no address on this channel.
          if (cause instanceof ChannelNotReachable) return;
          const error =
            cause instanceof ChannelDeliveryError ? cause.code : "unexpected";
          notificationLogger.warn("Notification delivery failed.", {
            event: "notification_delivery_failed",
            channel: channel.id,
            topic: topic.id,
            error,
            cause,
          });
          outcome = { status: "failed", error };
        }
        await recordDelivery(db, {
          notificationId: id,
          channel: channel.id,
          ...outcome,
        }).catch((cause) =>
          notificationLogger.warn("Notification delivery was not recorded.", {
            event: "notification_delivery_record_failed",
            channel: channel.id,
            topic: topic.id,
            status: outcome.status,
            cause,
          }),
        );
      }),
    ),
  );
};

const missingExecutionContextMessage = "This context has no ExecutionContext";

/**
 * Runs `publishNotification` after the response, or inline where there is no
 * ExecutionContext (tests and in-process callers). It never throws.
 */
export const scheduleNotification = async (
  executionContext: () => {
    readonly waitUntil: (promise: Promise<unknown>) => void;
  },
  bindings: Bindings,
  event: NotificationEvent,
): Promise<void> => {
  const publication = publishNotification(bindings, event).catch((cause) =>
    notificationLogger.error("Notification was not published.", {
      event: "notification_publish_failed",
      topic: event.topic,
      cause,
    }),
  );
  try {
    executionContext().waitUntil(publication);
  } catch (cause) {
    if (
      cause instanceof Error &&
      cause.message === missingExecutionContextMessage
    )
      return publication;
    throw cause;
  }
};
