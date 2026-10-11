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
  account_not_linked:
    "An account already uses this email. Sign in with email first; Google will work after that.",
  access_denied: "Google sign-in was canceled.",
  state_mismatch: "Sign-in timed out. Please try again.",
  please_restart_the_process: "Sign-in timed out. Please try again.",
};

const known = new Set(Object.keys(messages));

/** The reason code Better Auth attached to a failed request or redirect. */
export const signInErrorCode = (error: unknown) =>
  error instanceof BrowserAuthError ? error.code : undefined;

/** Human copy for a redirect `error` query or a failed request. */
export const signInErrorMessage = (error: unknown) => {
  if (typeof error === "string")
    return known.has(error)
      ? messages[error]
      : "Sign-in didn't finish. Please try again.";
  const code = signInErrorCode(error);
  if (code !== undefined && known.has(code)) return messages[code];
  return error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
};
