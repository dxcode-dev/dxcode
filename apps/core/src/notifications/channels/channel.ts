import type { NotificationChannel as NotificationChannelId } from "@dx/api";
import type { UserId } from "@dx/domain";
import type { NotificationContent } from "../topics.js";

/** Everything a channel needs to deliver one notification to one person. */
export interface ChannelDelivery {
  readonly recipient: {
    readonly userId: UserId;
    readonly name: string;
    readonly email: string;
  };
  readonly content: NotificationContent;
  /** Copy that names the topic: "Unsubscribe from mention emails". */
  readonly topicNoun: string;
  readonly links: {
    /** Opens the Thread at the message. */
    readonly open: string;
    /** Turns this topic off on this channel, without signing in. */
    readonly unsubscribe: string;
  };
}

/**
 * One way to reach a person outside the app: email today; push, WhatsApp,
 * or Telegram later. Adding a channel means writing one of these, listing it
 * in `channels/index.ts`, and adding its id to `NotificationChannelSchema`.
 * The publisher owns inbox rows, preferences, deduplication, delivery
 * records, and realtime updates; a channel only delivers.
 */
export interface NotificationChannel {
  readonly id: NotificationChannelId;
  /** Settings row title for a topic: "Mention notification emails". */
  readonly subscriptionTitle: (topicNoun: string) => string;
  /** Settings row description: "Receive an email when …". */
  readonly subscriptionDescription: (trigger: string) => string;
  /** False when this deployment lacks what the channel needs. */
  readonly available: boolean;
  /** Delivers or throws a `ChannelDeliveryError`. */
  readonly deliver: (delivery: ChannelDelivery) => Promise<void>;
}

/** A failed delivery, with a bounded code safe to store. */
export class ChannelDeliveryError extends Error {
  constructor(
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super(`Notification delivery failed: ${code}.`, options);
  }
}
