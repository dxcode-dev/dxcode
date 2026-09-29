import type { BetterAuthPlugin } from "@better-auth/core";
import { createAuthMiddleware } from "better-auth/api";
import { magicLink } from "better-auth/plugins";
import { encodeBase64Url } from "../encoding/base64.js";

export interface CloudflareMagicLinkOptions {
  readonly email: SendEmail;
  readonly from: string;
  readonly verifyRequest?: (token: string | null) => Promise<void>;
  readonly admitEmail?: (email: string) => Promise<boolean>;
}

const magicLinkToken = () =>
  encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));

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
        subject: "Sign in to dx",
        text: `Sign in to dx:\n\n${url}\n\nThis link expires in 10 minutes and can be used once. If you did not request it, ignore this email.`,
      });
    },
  });
  if (admitEmail === undefined && verifyRequest === undefined) return plugin;
  return {
    ...plugin,
    hooks: {
      before: [
        {
          matcher: ({ path }) => path === "/sign-in/magic-link",
          handler: createAuthMiddleware(async (context) => {
            await verifyRequest?.(
              context.headers?.get("x-turnstile-token") ?? null,
            );
            const recipient = context.body?.email;
            if (
              typeof recipient === "string" &&
              admitEmail !== undefined &&
              !(await admitEmail(recipient))
            ) {
              return context.json({ status: true });
            }
          }),
        },
      ],
    },
  };
};
