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
import { cutExcerpt, plainExcerptText } from "./excerpt.js";
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
  /**
   * The message to open the Thread at: a dx message id, a transcript row, a
   * Space post, or `call:<tool call id>` for the agent's own tool call.
   */
  readonly messageId?: string;
  /** The artifact to open, full screen on a phone. */
  readonly artifactId?: string;
  readonly actorUserId?: UserId;
  /** Who acted when no person did, such as the agent: "dx". */
  readonly actorName?: string;
  /** What was said, as plain text. */
  readonly excerpt: string;
  /** A headline the sender chose (the agent's `notify_user` title). */
  readonly subject?: string;
}

const EXCERPT_LENGTH = 280;

/**
 * Who a mention came from decides where it goes: a person's is a `mention`,
 * for the inbox, email, and push; an agent's is an `agent_notification`,
 * push unless the person opted in to agent emails, and never the inbox.
 */
export const mentionFrom = (
  author: { readonly userId: UserId } | "agent",
): Pick<NotificationEvent, "topic" | "actorUserId" | "actorName"> =>
  author === "agent"
    ? { topic: "agent_notification", actorName: "dx" }
    : { topic: "mention", actorUserId: author.userId };

/** Where tapping or clicking a notification lands, below the origin. */
export const notificationPath = (
  event: Pick<NotificationEvent, "threadId" | "messageId" | "artifactId">,
) => {
  const search = new URLSearchParams();
  if (event.messageId !== undefined) search.set("message", event.messageId);
  if (event.artifactId !== undefined) {
    search.set("artifact", event.artifactId);
    // A phone shows it full screen; a wide page opens its Artifacts view.
    search.set("sheet", "artifact");
  }
  const query = search.toString();
  return `/threads/${encodeURIComponent(event.threadId)}${query === "" ? "" : `?${query}`}`;
};

/**
 * A message's text without the tags dx adds for agents: a post's
 * `<post id="…" />`, an edit's `<edited_post>` and a comment's `<comments>`
 * blocks, and `<dx_…>` tags. People never see them.
 */
export const withoutInternalTags = (text: string) =>
  text
    .replace(/<edited_post\b[^>]*>[\s\S]*?<\/edited_post>/g, "")
    .replace(/<comments\b[^>]*>[\s\S]*?<\/comments>/g, "")
    .replace(/<post id="[^"]*" \/>/g, "")
    .replace(/<\/?dx_[a-z_]+\b[^>]*>/g, "")
    .trim();
/** `notify_user` promises the agent room for a 300-character body. */
const AGENT_NOTIFICATION_EXCERPT_LENGTH = 300;

/** The excerpt as plain text, cut on that text; see `excerpt.ts`. */
const excerptOf = (text: string, limit: number) =>
  cutExcerpt(plainExcerptText(text), limit);

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
  const excerpt = excerptOf(
    withoutInternalTags(event.excerpt),
    event.topic === "agent_notification"
      ? AGENT_NOTIFICATION_EXCERPT_LENGTH
      : EXCERPT_LENGTH,
  );
  const created = await insertNotifications(db, {
    ...event,
    recipients,
    excerpt,
    // dx's own notifications (no person, sent as "dx") show dx as sender.
    ...(event.actorUserId === undefined && event.actorName === "dx"
      ? { actorKind: "agent" as const }
      : {}),
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
      ? Promise.resolve({ name: event.actorName ?? "Someone" })
      : userIdentity(db, event.actorUserId),
  ]);
  const content = topic.content({
    actorName: actor.name,
    threadTitle: title,
    excerpt,
    ...(event.subject === undefined ? {} : { subject: event.subject }),
  });
  const open = `${origin}${notificationPath(event)}`;
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
