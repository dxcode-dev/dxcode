import {
  type AccessRequestOutcome,
  BrowserAuthenticationModeResponseSchema,
  MagicLinkRequestResponseSchema,
} from "@dx/api";
import { magicLinkClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { Effect, Schema } from "effect";

const authClient = createAuthClient({
  basePath: "/api/auth",
  plugins: [magicLinkClient()],
});

export const getBrowserAuthenticationConfiguration = async () => {
  const result = await authClient.$fetch<unknown>("/mode");
  if (result.error !== null)
    throw new Error("Authentication configuration failed.");
  const response = await Schema.decodeUnknownPromise(
    BrowserAuthenticationModeResponseSchema,
  )(result.data).catch(() => {
    throw new Error("Authentication configuration is invalid.");
  });
  return response;
};

export const getBrowserAuthenticationMode = async () =>
  (await getBrowserAuthenticationConfiguration()).mode;

class AuthenticationRequestError extends Schema.TaggedError<AuthenticationRequestError>()(
  "AuthenticationRequestError",
  { message: Schema.String },
) {}

export const browserCallbackURL = (
  location: Pick<Location, "hash" | "pathname" | "search">,
) => `${location.pathname}${location.search}${location.hash}`;

export const requestMagicLink = (
  email: string,
  token: string,
  callbackURL = browserCallbackURL(window.location),
) =>
  Effect.tryPromise({
    try: async () => {
      const result = await authClient.signIn.magicLink({
        email,
        callbackURL,
        fetchOptions: { headers: { "x-turnstile-token": token } },
      });
      if (result.error !== null) throw new Error(result.error.message);
      await Schema.decodeUnknownPromise(MagicLinkRequestResponseSchema)(
        result.data,
      );
      return "request-accepted" satisfies AccessRequestOutcome;
    },
    catch: (cause) =>
      new AuthenticationRequestError({
        message:
          cause instanceof Error ? cause.message : "Magic-link request failed.",
      }),
  });
