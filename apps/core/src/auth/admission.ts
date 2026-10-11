import {
  emailDomainAllowed,
  normalizeEmail,
  type SignInRejection,
} from "@dx/domain";
import { inviteSignupAdmission } from "../settings/members/service.js";
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
  configuration: Pick<SignInConfiguration, "admission" | "allowedEmailDomains">,
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
    case "waitlist":
      return (await waitlistAdmission(db)(input.email))
        ? undefined
        : "waitlisted";
  }
};
