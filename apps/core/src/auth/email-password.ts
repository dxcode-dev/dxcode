import type { BetterAuthPlugin } from "@better-auth/core";
import { APIError, createAuthMiddleware } from "better-auth/api";
import {
  emailVerificationEmail,
  existingAccountEmail,
} from "./email-messages.js";

export interface EmailPasswordOptions {
  /**
   * Sends the confirmation link; when present, sign-in waits for a verified
   * address. A sign-up for an existing account gets a sign-in reminder at
   * `signInUrl`, since the response cannot say the account exists.
   */
  readonly verification?: {
    readonly email: SendEmail;
    readonly from: string;
    readonly signInUrl: string;
  };
  /** Runs before sign-up, for example to check a Turnstile token. */
  readonly verifyRequest?: (token: string | null) => Promise<void>;
  /**
   * Throws when admission refuses a new address. Better Auth hides refusals
   * behind a generic response once verification is on, so the policy runs
   * here first to tell the person they are waitlisted or out of bounds.
   */
  readonly admitSignUp?: (email: string, callbackURL: unknown) => Promise<void>;
}

/**
 * Email/password sign-in. Who may sign up is decided by the shared admission
 * policy in `user.validateUserInfo`, not here.
 */
export const emailPassword = ({
  verification,
  verifyRequest,
  admitSignUp,
}: EmailPasswordOptions = {}): BetterAuthPlugin => ({
  id: "dx-email-password",
  init: () => ({
    options: {
      emailAndPassword: {
        enabled: true,
        autoSignIn: verification === undefined,
        requireEmailVerification: verification !== undefined,
        ...(verification === undefined
          ? {}
          : {
              onExistingUserSignUp: async ({
                user,
              }: {
                readonly user: { readonly email: string };
              }) => {
                await verification.email.send({
                  from: { email: verification.from, name: "dx" },
                  to: user.email,
                  ...existingAccountEmail(verification.signInUrl),
                });
              },
            }),
      },
      ...(verification === undefined
        ? {}
        : {
            emailVerification: {
              sendOnSignUp: true,
              sendOnSignIn: true,
              autoSignInAfterVerification: true,
              expiresIn: 60 * 60,
              sendVerificationEmail: async ({
                user,
                url,
              }: {
                readonly user: { readonly email: string };
                readonly url: string;
              }) => {
                await verification.email.send({
                  from: { email: verification.from, name: "dx" },
                  to: user.email,
                  ...emailVerificationEmail(url),
                });
              },
            },
          }),
    },
  }),
  hooks: {
    before: [
      {
        matcher: ({ path }) => path === "/sign-up/email",
        handler: createAuthMiddleware(async (context) => {
          if (typeof context.body?.email !== "string")
            throw new APIError("BAD_REQUEST", {
              message: "Account creation is unavailable.",
            });
          await verifyRequest?.(
            context.headers?.get("x-turnstile-token") ?? null,
          );
          await admitSignUp?.(context.body.email, context.body?.callbackURL);
        }),
      },
    ],
  },
});
