import type { NotificationChannel as NotificationChannelId } from "@dx/api";
import { deploymentEmailSender } from "../../email/sender.js";
import type { Bindings } from "../../http/types.js";
import type { NotificationChannel } from "./channel.js";
import { emailChannel } from "./email.js";

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
 * The delivery channels this deployment composes, each reporting whether it
 * can deliver. Add a channel here; settings and delivery pick it up.
 */
export const notificationChannels = (
  bindings: Pick<
    Bindings,
    "DX_AUTH_EMAIL_FROM" | "EMAIL" | "DX_AUTH_URL" | "BETTER_AUTH_SECRET"
  >,
): Readonly<Record<NotificationChannelId, NotificationChannel>> => ({
  email: emailChannel(
    linksConfigured(bindings) ? deploymentEmailSender(bindings) : undefined,
  ),
});
