import {
  emailDomainAllowed,
  normalizeEmail,
  type SignInRejection,
} from "@dx/domain";
import { senderAddress } from "../email/sender.js";
import { authenticationLogger } from "../logging.js";
import { inviteSignupAdmission } from "../settings/members/service.js";
import { waitlistJoinedEmail } from "./email-messages.js";
import type { SignInConfiguration } from "./sign-in-configuration.js";
import { waitlistAdmission, waitlistApproved } from "./waitlist.js";

export const signInRejectionMessages: Record<SignInRejection, string> = {
  waitlisted: "You're on the waitlist.",
  email_domain_not_allowed:
    "This email domain can't be used to sign in to this dx deployment.",
  signup_closed:
    "No dx account uses this email. Ask a workspace admin for an invite.",
  email_unverified:
    "Your provider hasn't verified this email address, so it can't be used to create an account.",
};

export const userExists = async (db: D1Database, email: string) =>
  (await db
    .prepare('SELECT 1 AS found FROM "user" WHERE email = ?')
    .bind(normalizeEmail(email))
    .first("found")) !== null;

/**
 * Decides whether a new identity may become a user. A valid workspace invite
 * link or an operator-approved address (the bootstrapped administrator, or an
 * approved waitlist entry) admits it under every policy, including the domain
 * allowlist; the waitlist records unknown addresses as pending.
 */
export const admitNewIdentity = async (
  db: D1Database,
  configuration: Pick<
    SignInConfiguration,
    "admission" | "allowedEmailDomains" | "email"
  >,
  input: { readonly email: string; readonly callbackURL: unknown },
): Promise<SignInRejection | undefined> => {
  if (await inviteSignupAdmission(db, input.callbackURL)) return undefined;
  if (await waitlistApproved(db, input.email)) return undefined;
  if (!emailDomainAllowed(input.email, configuration.allowedEmailDomains))
    return "email_domain_not_allowed";
  switch (configuration.admission) {
    case "open":
      return undefined;
    case "invite":
      return "signup_closed";
    case "waitlist": {
      const outcome = await waitlistAdmission(db)(input.email);
      if (outcome === "approved") return undefined;
      if (outcome === "joined")
        await sendWaitlistJoined(configuration.email, input.email);
      return "waitlisted";
    }
  }
};

/**
 * Tells a person once that they joined the waitlist. Without an email
 * sender, or if sending fails, they still see the waitlist message on the
 * sign-in page, so a failure is logged and never refuses the request.
 */
const sendWaitlistJoined = async (
  sender: SignInConfiguration["email"],
  to: string,
) => {
  if (sender === undefined) return;
  try {
    await sender.binding.send({
      from: senderAddress(sender),
      to: normalizeEmail(to),
      ...waitlistJoinedEmail(),
    });
  } catch (error) {
    authenticationLogger.warn("Waitlist email failed.", {
      event: "waitlist_joined_email_failed",
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
