import type { NotificationChannel, NotificationTopic } from "@dx/api";

/**
 * What a notification says, independent of how it is delivered. Each channel
 * renders it its own way: email as a card, push as a title and body, a chat
 * service as a short message.
 */
export interface NotificationContent {
  /** One line: an email subject, a push title, a chat preview. */
  readonly subject: string;
  /** "Ada mentioned you". */
  readonly headline: string;
  /** The Thread's title. */
  readonly title: string;
  /** What was said, as plain text. */
  readonly body: string;
  readonly actorName?: string;
  /** Why the recipient got it: "someone mentioned you in dx". */
  readonly reason: string;
}

export interface NotificationTopicDefinition {
  readonly id: NotificationTopic;
  /** Names the topic in copy: "Unsubscribe from mention emails". */
  readonly noun: string;
  /** Completes "Receive … when ": "someone mentions you in a shared thread". */
  readonly trigger: string;
  /** Whether a channel delivers this topic for someone who never chose. */
  readonly defaults: Readonly<Record<NotificationChannel, boolean>>;
  readonly content: (input: {
    readonly actorName: string;
    readonly threadTitle: string;
    readonly excerpt: string;
  }) => NotificationContent;
}

const mention: NotificationTopicDefinition = {
  id: "mention",
  noun: "mention",
  trigger: "someone mentions you in a shared thread",
  defaults: { email: true },
  content: ({ actorName, threadTitle, excerpt }) => ({
    subject: `${actorName} mentioned you in ${threadTitle}`,
    headline: `${actorName} mentioned you`,
    title: threadTitle,
    body: excerpt,
    actorName,
    reason: "someone mentioned you in dx",
  }),
};

/** Every topic, in the order settings list them. */
export const NOTIFICATION_TOPICS: Readonly<
  Record<NotificationTopic, NotificationTopicDefinition>
> = { mention };
