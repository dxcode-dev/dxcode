import {
  emailDomainAllowed,
  normalizeEmail,
  type SignInRejection,
} from "@dx/domain";
import { senderAddress } from "../email/sender.js";
import { authenticationLogger } from "../logging.js";
import { inviteSignupAdmission } from "../settings/members/service.js";
import { signInRefusedEmail, waitlistJoinedEmail } from "./email-messages.js";
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
  input: {
    readonly email: string;
    readonly callbackURL: unknown;
    /**
     * False when the caller emails every refusal itself
     * (`sendSignInRefusal`), so a new waitlist entry is not told twice.
     */
    readonly notifyJoined?: boolean;
  },
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
      if (outcome === "joined" && input.notifyJoined !== false)
        await sendSignInRefusal(configuration.email, input.email, "waitlisted");
      return "waitlisted";
    }
  }
};

/**
 * Tells an address by email why it gets no sign-in link, so the response
 * itself never has to say whether an account exists. Without an email
 * sender, or if sending fails, the request still succeeds: a failure is
 * logged and never refuses it.
 */
export const sendSignInRefusal = async (
  sender: SignInConfiguration["email"],
  to: string,
  rejection: SignInRejection,
) => {
  if (sender === undefined) return;
  try {
    await sender.binding.send({
      from: senderAddress(sender),
      to: normalizeEmail(to),
      ...(rejection === "waitlisted"
        ? waitlistJoinedEmail()
        : signInRefusedEmail(signInRejectionMessages[rejection])),
    });
  } catch (error) {
    authenticationLogger.warn("Sign-in refusal email failed.", {
      event: "sign_in_refusal_email_failed",
      rejection,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
