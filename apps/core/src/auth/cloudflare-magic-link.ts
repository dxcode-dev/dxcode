import type { BetterAuthPlugin } from "@better-auth/core";
import type { MagicLinkRequestOutcome } from "@dx/api";
import { createAuthMiddleware } from "better-auth/api";
import { magicLink } from "better-auth/plugins";
import { encodeBase64Url } from "../encoding/base64.js";
import { signInLinkEmail } from "./email-messages.js";

export interface CloudflareMagicLinkOptions {
  readonly email: SendEmail;
  readonly from: string;
  readonly verifyRequest?: (token: string | null) => Promise<void>;
  /**
   * Decides before any email is sent. Returns `waitlisted` to skip the email,
   * or throws an APIError to refuse the request.
   */
  readonly admitEmail?: (
    email: string,
    callbackURL: unknown,
  ) => Promise<MagicLinkRequestOutcome>;
}

const magicLinkToken = () =>
  encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));

const requestPath = "/sign-in/magic-link";

export const cloudflareMagicLink = ({
  email,
  from,
  admitEmail,
  verifyRequest,
}: CloudflareMagicLinkOptions): BetterAuthPlugin => {
  const plugin = magicLink({
    expiresIn: 10 * 60,
    storeToken: "hashed",
    generateToken: magicLinkToken,
    sendMagicLink: async ({ email: recipient, url }) => {
      await email.send({
        from: { email: from, name: "dx" },
        to: recipient,
        ...signInLinkEmail(url),
      });
    },
  });
  return {
    ...plugin,
    hooks: {
      before: [
        {
          matcher: ({ path }) => path === requestPath,
          handler: createAuthMiddleware(async (context) => {
            await verifyRequest?.(
              context.headers?.get("x-turnstile-token") ?? null,
            );
            const recipient = context.body?.email;
            if (
              typeof recipient === "string" &&
              admitEmail !== undefined &&
              (await admitEmail(recipient, context.body?.callbackURL)) ===
                "waitlisted"
            ) {
              return context.json({
                status: true,
                outcome: "waitlisted" satisfies MagicLinkRequestOutcome,
              });
            }
          }),
        },
      ],
      after: [
        {
          matcher: ({ path }) => path === requestPath,
          handler: createAuthMiddleware(async (context) => {
            const returned = context.context.returned;
            if (
              typeof returned === "object" &&
              returned !== null &&
              !(returned instanceof Response) &&
              "status" in returned &&
              returned.status === true &&
              !("outcome" in returned)
            )
              return context.json({
                status: true,
                outcome: "sent" satisfies MagicLinkRequestOutcome,
              });
          }),
        },
      ],
    },
  };
};
