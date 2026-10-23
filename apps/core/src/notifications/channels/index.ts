import type { NotificationChannel as NotificationChannelId } from "@dx/api";
import { deploymentEmailSender } from "../../email/sender.js";
import type { Bindings } from "../../http/types.js";
import type { NotificationChannel } from "./channel.js";
import { emailChannel } from "./email.js";
import { pushChannel } from "./push.js";
import type { VapidKeys } from "./web-push.js";

/**
 * Every channel's messages link back to the deployment and carry a signed
 * unsubscribe link, so a channel delivers only when both can be built.
 */
const linksConfigured = (
  bindings: Pick<Bindings, "DX_AUTH_URL" | "BETTER_AUTH_SECRET">,
) =>
  (bindings.DX_AUTH_URL?.trim() ?? "") !== "" &&
  bindings.BETTER_AUTH_SECRET !== undefined;

/**
 * The deployment's VAPID identity, from its two secrets. Both are base64url,
 * exactly as every Web Push key generator emits them: the uncompressed P-256
 * public key browsers subscribe with, and its private scalar.
 */
export const deploymentVapidKeys = (
  bindings: Pick<
    Bindings,
    "DX_PUSH_VAPID_PUBLIC_KEY" | "DX_PUSH_VAPID_PRIVATE_KEY"
  >,
): VapidKeys | undefined => {
  const publicKey = bindings.DX_PUSH_VAPID_PUBLIC_KEY?.trim();
  const privateKey = bindings.DX_PUSH_VAPID_PRIVATE_KEY?.trim();
  return publicKey === undefined ||
    publicKey === "" ||
    privateKey === undefined ||
    privateKey === ""
    ? undefined
    : { publicKey, privateKey };
};

export type NotificationChannelBindings = Pick<
  Bindings,
  | "DX_AUTH_EMAIL_FROM"
  | "EMAIL"
  | "DX_AUTH_URL"
  | "BETTER_AUTH_SECRET"
  | "DX_PUSH_VAPID_PUBLIC_KEY"
  | "DX_PUSH_VAPID_PRIVATE_KEY"
  | "DB"
>;

/**
 * The delivery channels this deployment composes, each reporting whether it
 * can deliver. Add a channel here; settings and delivery pick it up.
 */
export const notificationChannels = (
  bindings: NotificationChannelBindings,
): Readonly<Record<NotificationChannelId, NotificationChannel>> => {
  const links = linksConfigured(bindings);
  const keys = deploymentVapidKeys(bindings);
  const origin = bindings.DX_AUTH_URL?.trim().replace(/\/+$/, "");
  return {
    email: emailChannel(links ? deploymentEmailSender(bindings) : undefined),
    push: pushChannel(
      links && keys !== undefined && bindings.DB !== undefined && origin
        ? { db: bindings.DB, keys, subject: origin }
        : undefined,
    ),
  };
};
