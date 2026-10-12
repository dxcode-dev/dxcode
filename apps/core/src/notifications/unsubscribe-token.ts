import {
  type NotificationChannel,
  NotificationChannelSchema,
  type NotificationTopic,
  NotificationTopicSchema,
} from "@dx/api";
import { UserId } from "@dx/domain";
import { Option, Schema } from "effect";
import { decodeBase64Url, encodeBase64Url } from "../encoding/base64.js";

/**
 * An email's unsubscribe link turns one topic off on one channel for one
 * person without signing in, so the link carries those three, signed with a
 * key derived from the deployment's auth secret. It does not expire: an old
 * email's link keeps working, and it can only ever turn a notification off.
 */
export interface UnsubscribeGrant {
  readonly userId: UserId;
  readonly topic: NotificationTopic;
  readonly channel: NotificationChannel;
}

const VERSION = "v1";
const encoder = new TextEncoder();

const Payload = Schema.Struct({
  u: UserId,
  t: NotificationTopicSchema,
  c: NotificationChannelSchema,
});

const signingKey = (secret: string) =>
  crypto.subtle.importKey(
    "raw",
    encoder.encode(`dx notification unsubscribe\n${secret}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );

export const signUnsubscribeToken = async (
  secret: string,
  grant: UnsubscribeGrant,
) => {
  const payload = encodeBase64Url(
    encoder.encode(
      JSON.stringify({ u: grant.userId, t: grant.topic, c: grant.channel }),
    ),
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    await signingKey(secret),
    encoder.encode(`${VERSION}.${payload}`),
  );
  return `${VERSION}.${payload}.${encodeBase64Url(new Uint8Array(signature))}`;
};

/** The grant a genuine token names, or undefined for anything else. */
export const verifyUnsubscribeToken = async (
  secret: string,
  token: string,
): Promise<UnsubscribeGrant | undefined> => {
  const [version, payload, signature, ...rest] = token.split(".");
  if (
    version !== VERSION ||
    payload === undefined ||
    signature === undefined ||
    rest.length > 0 ||
    token.length > 512
  )
    return undefined;
  try {
    const valid = await crypto.subtle.verify(
      "HMAC",
      await signingKey(secret),
      Uint8Array.from(decodeBase64Url(signature)),
      encoder.encode(`${VERSION}.${payload}`),
    );
    if (!valid) return undefined;
    const decoded = Schema.decodeUnknownOption(Payload)(
      JSON.parse(new TextDecoder().decode(decodeBase64Url(payload))),
    );
    return Option.isNone(decoded)
      ? undefined
      : {
          userId: decoded.value.u,
          topic: decoded.value.t,
          channel: decoded.value.c,
        };
  } catch {
    return undefined;
  }
};
