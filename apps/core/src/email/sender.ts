import { Predicate } from "effect";
import type { Bindings } from "../http/types.js";

/**
 * The deployment's Cloudflare Email Sending sender: one address on the
 * operator's zone (`DX_AUTH_EMAIL_FROM`) and the `EMAIL` binding allowed to
 * send from it. Sign-in email (magic links, verification) and notification
 * email share it; whether magic-link sign-in is offered does not matter.
 */
export interface EmailSender {
  readonly binding: SendEmail;
  readonly from: string;
}

/** The configured sender, or undefined when the deployment sends no email. */
export const deploymentEmailSender = (
  bindings: Pick<Bindings, "DX_AUTH_EMAIL_FROM" | "EMAIL">,
): EmailSender | undefined => {
  const from = bindings.DX_AUTH_EMAIL_FROM?.trim();
  return from !== undefined &&
    from.length > 0 &&
    Predicate.isObject(bindings.EMAIL) &&
    Predicate.isFunction(bindings.EMAIL.send)
    ? { binding: bindings.EMAIL, from }
    : undefined;
};

/** Every dx email shows the lowercase product name as its sender. */
export const senderAddress = (sender: EmailSender) => ({
  email: sender.from,
  name: "dx",
});
