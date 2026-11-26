import type { BetterAuthPlugin } from "@better-auth/core";
import { createAuthEndpoint } from "@better-auth/core/api";
import { sessionMiddleware } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import * as z from "zod";
import { encodeBase64Url } from "../encoding/base64.js";

/**
 * Sign-in handoff from the browser to dx's native apps. Some sign-ins end
 * in the system browser, not in the app: a magic link opens from Mail, a
 * provider's page runs there. The app sends the person to
 * `/native-sign-in` in the browser with a PKCE challenge; once the browser
 * is signed in, the web page asks this plugin for a one-time code and hands
 * it to the app through the app's URL scheme. The app then loads
 * `redeem` in its own web view with the challenge's verifier, which gives
 * the app a session of its own (signing out of one leaves the other).
 *
 * - The code lives two minutes, works once, and is stored hashed.
 * - Only the app that made the challenge holds the verifier, so another app
 *   that registered the same URL scheme can't redeem an intercepted code.
 */

const PREFIX = "native-handoff:";
/** Seconds a handoff code stays redeemable. */
const CODE_LIFETIME = 120;

const sha256 = async (text: string) =>
  encodeBase64Url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
  );

/** A base64url SHA-256: 43 characters. */
const challengeSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);

export const nativeHandoff = (): BetterAuthPlugin => ({
  id: "native-handoff",
  endpoints: {
    createNativeHandoff: createAuthEndpoint(
      "/native-handoff/create",
      {
        method: "POST",
        use: [sessionMiddleware],
        body: z.object({ challenge: challengeSchema }),
      },
      async (context) => {
        const code = encodeBase64Url(
          crypto.getRandomValues(new Uint8Array(32)),
        );
        await context.context.internalAdapter.createVerificationValue({
          identifier: `${PREFIX}${await sha256(code)}`,
          value: JSON.stringify({
            userId: context.context.session.user.id,
            challenge: context.body.challenge,
          }),
          expiresAt: new Date(Date.now() + CODE_LIFETIME * 1000),
        });
        return context.json({ code, expiresIn: CODE_LIFETIME });
      },
    ),
    redeemNativeHandoff: createAuthEndpoint(
      "/native-handoff/redeem",
      {
        method: "GET",
        query: z.object({
          code: z.string().min(1).max(128),
          verifier: z.string().min(43).max(128),
        }),
      },
      async (context) => {
        const { code, verifier } = context.query;
        const stored =
          await context.context.internalAdapter.consumeVerificationValue(
            `${PREFIX}${await sha256(code)}`,
          );
        const value = (() => {
          try {
            return JSON.parse(stored?.value ?? "") as {
              userId?: unknown;
              challenge?: unknown;
            };
          } catch {
            return undefined;
          }
        })();
        if (
          stored === null ||
          stored === undefined ||
          stored.expiresAt < new Date() ||
          typeof value?.userId !== "string" ||
          value.challenge !== (await sha256(verifier))
        )
          throw context.error("BAD_REQUEST", {
            message: "This sign-in link has expired. Start again in the app.",
          });
        const user = await context.context.internalAdapter.findUserById(
          value.userId,
        );
        if (user === null)
          throw context.error("BAD_REQUEST", { message: "Account not found." });
        const session = await context.context.internalAdapter.createSession(
          user.id,
        );
        await setSessionCookie(context, { session, user });
        throw context.redirect("/");
      },
    ),
  },
});
