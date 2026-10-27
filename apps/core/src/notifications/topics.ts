import type { NotificationChannel, NotificationTopic } from "@dx/api";
import { plainPreview } from "./plain-preview.js";

/**
 * What a notification says, independent of how it is delivered. Each channel
 * renders it its own way: email as a card, push as a title and body, a chat
 * service as a short message.
 */
export interface NotificationContent {
  /** One line that stands alone: an email subject. */
  readonly subject: string;
  /** "Ada mentioned you". */
  readonly headline: string;
  /** The Thread's title. */
  readonly title: string;
  /** What was said, as plain text. */
  readonly body: string;
  /**
   * What a push or chat preview shows under the Thread's title: who said
   * what, or why the Thread came back, so the title can stay the Thread's.
   */
  readonly preview: string;
  readonly actorName?: string;
  /** Why the recipient got it: "someone mentioned you in dx". */
  readonly reason: string;
}

export interface NotificationTopicDefinition {
  readonly id: NotificationTopic;
  /** Names the topic in copy: "Unsubscribe from mention emails". */
  readonly noun: string;
  /** Completes "Receive … when ": "someone @-mentions you in a shared Thread". */
  readonly trigger: string;
  /**
   * Whether the topic also appears in the in-app Mentions inbox. A topic
   * that does not still records a row, which deduplicates the event and
   * carries its delivery outcomes.
   */
  readonly inbox: boolean;
  /**
   * The channels this topic is offered on, and whether each delivers for
   * someone who never chose. A channel the topic omits is not offered at
   * all: only a mention is worth an email, so the others are push only.
   */
  readonly defaults: Readonly<Partial<Record<NotificationChannel, boolean>>>;
  readonly content: (input: {
    readonly actorName: string;
    readonly threadTitle: string;
    readonly excerpt: string;
    /** A headline the sender chose, for topics that take one. */
    readonly subject?: string;
  }) => NotificationContent;
}

const mention: NotificationTopicDefinition = {
  id: "mention",
  noun: "mention",
  trigger: "someone @-mentions you in a shared Thread",
  inbox: true,
  defaults: { email: true, push: true },
  content: ({ actorName, threadTitle, excerpt }) => ({
    subject: `${actorName} mentioned you in ${threadTitle}`,
    headline: `${actorName} mentioned you`,
    title: threadTitle,
    body: excerpt,
    preview: `${actorName}: ${plainPreview(excerpt) || excerpt}`,
    actorName,
    reason: "someone mentioned you in dx",
  }),
};

/**
 * The agent settled a turn in a Thread its owner started. It is addressed to
 * one person about their own Thread, so it stays out of the Mentions inbox,
 * where the sidebar already shows the Thread going idle, and off email: a
 * turn finishes far more often than someone tags you.
 */
const turnCompleted: NotificationTopicDefinition = {
  id: "turn_completed",
  noun: "agent update",
  trigger: "the agent finishes a turn in one of your Threads",
  inbox: false,
  defaults: { push: true },
  content: ({ threadTitle, excerpt }) => ({
    subject: `The agent finished in ${threadTitle}`,
    headline: "The agent finished its turn",
    title: threadTitle,
    body: excerpt,
    preview: excerpt,
    actorName: "dx",
    reason: "your Thread's agent finished a turn",
  }),
};

/**
 * A Thread the person snoozed reached its wake time. Like the agent update
 * it is a nudge about their own Thread, so it is push only and stays out of
 * the Mentions inbox; the sidebar already moves the Thread back. The excerpt
 * is what the agent last said there, empty when it said nothing, so the
 * push reminds the person where the Thread left off.
 */
const snoozeWoke: NotificationTopicDefinition = {
  id: "snooze_woke",
  noun: "snoozed Thread",
  trigger: "a Thread you snoozed wakes up",
  inbox: false,
  defaults: { push: true },
  content: ({ threadTitle, excerpt }) => ({
    subject: `${threadTitle} is back`,
    headline: "A Thread you snoozed woke up",
    title: threadTitle,
    body: excerpt,
    preview:
      excerpt === "" ? "Back from snooze." : `Back from snooze: ${excerpt}`,
    actorName: "dx",
    reason: "a Thread you snoozed woke up",
  }),
};

/**
 * The agent's `notify_user` tool: something the owner asked to hear about
 * happened, such as a deploy finishing. The agent writes the headline and
 * the text. Push only, like the agent update; it never reaches the inbox.
 */
const agentNotification: NotificationTopicDefinition = {
  id: "agent_notification",
  noun: "agent notification",
  trigger: "an agent notifies you about something you asked it to watch",
  inbox: false,
  defaults: { push: true },
  content: ({ threadTitle, excerpt, subject }) => ({
    subject: subject ?? `Update from ${threadTitle}`,
    headline: subject ?? "The agent sent an update",
    title: threadTitle,
    body: excerpt,
    // Like every push, the Thread's title on top; the agent's own headline
    // leads the preview.
    preview:
      subject === undefined
        ? plainPreview(excerpt) || excerpt
        : `${subject}: ${plainPreview(excerpt) || excerpt}`,
    actorName: "dx",
    reason: "you asked an agent to notify you",
  }),
};

/** Every topic, in the order settings list them. */
export const NOTIFICATION_TOPICS: Readonly<
  Record<NotificationTopic, NotificationTopicDefinition>
> = {
  mention,
  turn_completed: turnCompleted,
  snooze_woke: snoozeWoke,
  agent_notification: agentNotification,
};

/** The channels a topic is offered on, in channel order. */
export const topicOffersChannel = (
  topic: NotificationTopicDefinition,
  channel: NotificationChannel,
) => topic.defaults[channel] !== undefined;

/** Topics whose rows the in-app inbox lists, as a SQL literal list. */
export const INBOX_TOPICS_SQL = Object.values(NOTIFICATION_TOPICS)
  .filter(({ inbox }) => inbox)
  .map(({ id }) => `'${id}'`)
  .join(", ");
