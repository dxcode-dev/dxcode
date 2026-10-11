import { Schema } from "effect";

/** A Better Auth sign-in method a deployment can offer. */
export const SignInProviderId = Schema.Literals([
  "magic-link",
  "email-password",
  "google",
]);
export type SignInProviderId = typeof SignInProviderId.Type;

/**
 * Who may create an account. Existing users always sign in, and a valid
 * workspace invite link admits a new user under every policy.
 */
export const SignInAdmission = Schema.Literals(["open", "waitlist", "invite"]);
export type SignInAdmission = typeof SignInAdmission.Type;

/** Why a new identity was not admitted. */
export const SignInRejection = Schema.Literals([
  "waitlisted",
  "email_domain_not_allowed",
  "signup_closed",
  "email_unverified",
]);
export type SignInRejection = typeof SignInRejection.Type;

const emailDomainPattern =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** A lowercase DNS name such as `example.com`; matched exactly, never as a suffix. */
export const AllowedEmailDomain = Schema.String.check(
  Schema.isPattern(emailDomainPattern),
);

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

export const emailDomain = (email: string) => {
  const normalized = normalizeEmail(email);
  const separator = normalized.lastIndexOf("@");
  return separator <= 0 || separator === normalized.length - 1
    ? undefined
    : normalized.slice(separator + 1);
};

/** An empty allowlist admits every domain. */
export const emailDomainAllowed = (
  email: string,
  allowedDomains: readonly string[],
) => {
  if (allowedDomains.length === 0) return true;
  const domain = emailDomain(email);
  return domain !== undefined && allowedDomains.includes(domain);
};
