import type { SignInOptionsResponse } from "@dx/api";
import { BrowserAuthError } from "../../shared/auth/auth-client.js";

const messages: Record<string, string> = {
  email_domain_not_allowed:
    "This email domain can't be used to sign in here. Use your work email.",
  signup_closed:
    "No dx account uses this email. Ask a workspace admin for an invite link.",
  email_unverified:
    "Google hasn't verified this email address. Verify it with Google, or sign in with email.",
  INVALID_TOKEN:
    "That link is invalid or was already used. Request a new one below.",
  EXPIRED_TOKEN: "That link has expired. Request a new one below.",
  TOKEN_EXPIRED: "That link has expired. Request a new one below.",
  INVALID_EMAIL_OR_PASSWORD: "That email and password don't match.",
  access_denied: "Google sign-in was canceled.",
  state_mismatch: "Sign-in timed out. Please try again.",
  please_restart_the_process: "Sign-in timed out. Please try again.",
};

/**
 * Better Auth links Google only to an account whose email is confirmed. What
 * confirms it depends on the methods the deployment offers.
 */
const accountNotLinked = (
  options: Pick<SignInOptionsResponse, "providers" | "emailVerification">,
) =>
  options.providers.includes("magic-link")
    ? "An account already uses this email. Sign in with an email link first; Google will work after that."
    : options.providers.includes("email-password") && options.emailVerification
      ? "An account already uses this email, but its address isn't confirmed yet. Sign in with your password and open the confirmation email; Google will work after that."
      : "An account already uses this email, but its address isn't confirmed yet, so Google can't be added to it. Ask your dx administrator to confirm the address.";

const known = new Set([...Object.keys(messages), "account_not_linked"]);

const messageFor = (
  code: string,
  options: Pick<SignInOptionsResponse, "providers" | "emailVerification">,
) =>
  code === "account_not_linked" ? accountNotLinked(options) : messages[code];

/** The reason code Better Auth attached to a failed request or redirect. */
export const signInErrorCode = (error: unknown) =>
  error instanceof BrowserAuthError ? error.code : undefined;

/** Human copy for a redirect `error` query or a failed request. */
export const signInErrorMessage = (
  error: unknown,
  options: Pick<SignInOptionsResponse, "providers" | "emailVerification">,
) => {
  if (typeof error === "string")
    return known.has(error)
      ? messageFor(error, options)
      : "Sign-in didn't finish. Please try again.";
  const code = signInErrorCode(error);
  if (code !== undefined && known.has(code)) return messageFor(code, options);
  return error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
};
