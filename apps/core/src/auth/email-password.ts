import type { BetterAuthPlugin } from "@better-auth/core";
import { APIError, createAuthMiddleware } from "better-auth/api";

const accountCreationUnavailable = () =>
  new APIError("BAD_REQUEST", {
    message: "Account creation is unavailable.",
  });

const emailDomain = (email: string) => {
  const separator = email.lastIndexOf("@");
  return separator <= 0 ? undefined : email.slice(separator + 1).toLowerCase();
};

export const emailPassword = (
  allowedSignupDomain: string | undefined,
  signupEnabled = false,
  admitInvitedSignup?: (callbackURL: unknown) => Promise<boolean>,
): BetterAuthPlugin => ({
  id: "dx-email-password",
  init: () => ({
    options: {
      emailAndPassword: {
        enabled: true,
        disableSignUp: !signupEnabled && admitInvitedSignup === undefined,
        autoSignIn: true,
        requireEmailVerification: false,
      },
    },
  }),
  hooks: {
    before: [
      {
        matcher: ({ path }) => path === "/sign-up/email",
        handler: createAuthMiddleware(async (context) => {
          const email = context.body?.email;
          if (
            typeof email !== "string" ||
            (allowedSignupDomain !== undefined &&
              emailDomain(email) !== allowedSignupDomain)
          ) {
            throw accountCreationUnavailable();
          }
          // A valid workspace invite link admits sign-up when public
          // sign-up is off.
          if (
            !signupEnabled &&
            !(await admitInvitedSignup?.(context.body?.callbackURL))
          ) {
            throw accountCreationUnavailable();
          }
        }),
      },
    ],
  },
});
