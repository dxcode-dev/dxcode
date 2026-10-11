import { apiKeyClient } from "@better-auth/api-key/client";
import {
  MagicLinkRequestResponseSchema,
  SignInOptionsResponseSchema,
} from "@dx/api";
import { magicLinkClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { Schema } from "effect";

// The session lives in TanStack Query (features/authentication), so the
// Better Auth client never polls or refetches on focus by itself.
const authClient = createAuthClient({
  basePath: "/api/auth",
  plugins: [apiKeyClient(), magicLinkClient()],
  sessionOptions: { refetchOnWindowFocus: false, refetchInterval: 0 },
});

/** A refused auth request. `code` is Better Auth's machine-readable reason when it sent one. */
export class BrowserAuthError extends Error {
  readonly code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "BrowserAuthError";
    this.code = code;
  }
}

const failure = (
  error: { readonly message?: string; readonly code?: string } | null,
  fallback: string,
) =>
  new BrowserAuthError(
    error?.message && error.message.length > 0 ? error.message : fallback,
    error?.code,
  );

export interface BrowserSession {
  readonly user: {
    readonly id: string;
    readonly name: string;
    readonly email: string;
  };
}

/** Resolves to `null` when nobody is signed in. */
export const getBrowserSession = async (): Promise<BrowserSession | null> => {
  const result = await authClient.getSession();
  if (result.error !== null) {
    if (result.error.status === 401) return null;
    throw failure(result.error, "Session check failed.");
  }
  return result.data === null ? null : { user: result.data.user };
};

export const getSignInOptions = async () => {
  const result = await authClient.$fetch<unknown>("/sign-in-options");
  if (result.error !== null)
    throw new BrowserAuthError("Sign-in isn't available right now.");
  return Schema.decodeUnknownPromise(SignInOptionsResponseSchema)(
    result.data,
  ).catch(() => {
    throw new BrowserAuthError("Sign-in configuration is invalid.");
  });
};

const turnstileHeaders = (token: string | undefined) =>
  token === undefined ? undefined : { headers: { "x-turnstile-token": token } };

export const requestMagicLink = async (input: {
  readonly email: string;
  readonly callbackURL: string;
  readonly errorCallbackURL: string;
  readonly turnstileToken?: string;
}) => {
  const result = await authClient.signIn.magicLink({
    email: input.email,
    callbackURL: input.callbackURL,
    errorCallbackURL: input.errorCallbackURL,
    newUserCallbackURL: input.callbackURL,
    fetchOptions: turnstileHeaders(input.turnstileToken),
  });
  if (result.error !== null)
    throw failure(result.error, "We couldn't send a sign-in link.");
  return (
    await Schema.decodeUnknownPromise(MagicLinkRequestResponseSchema)(
      result.data,
    )
  ).outcome;
};

export const signInWithPassword = async (input: {
  readonly email: string;
  readonly password: string;
  readonly callbackURL: string;
}) => {
  const result = await authClient.signIn.email(input);
  if (result.error !== null)
    throw failure(result.error, "Email sign-in failed.");
};

/** Resolves `verify-email` when the address must be confirmed before the first session. */
export const signUpWithPassword = async (input: {
  readonly name: string;
  readonly email: string;
  readonly password: string;
  readonly callbackURL: string;
  readonly turnstileToken?: string;
}) => {
  const { turnstileToken, ...body } = input;
  const result = await authClient.signUp.email({
    ...body,
    fetchOptions: turnstileHeaders(turnstileToken),
  });
  if (result.error !== null)
    throw failure(result.error, "Account creation failed.");
  return result.data?.token ? "signed-in" : "verify-email";
};

/** Navigates the browser to Google; resolves only if the redirect could not start. */
export const signInWithGoogle = async (input: {
  readonly callbackURL: string;
  readonly errorCallbackURL: string;
}) => {
  const result = await authClient.signIn.social({
    provider: "google",
    callbackURL: input.callbackURL,
    errorCallbackURL: input.errorCallbackURL,
    newUserCallbackURL: input.callbackURL,
  });
  if (result.error !== null)
    throw failure(result.error, "Google sign-in couldn't start.");
};

export const signOut = async () => {
  const result = await authClient.signOut();
  if (result.error !== null) throw failure(result.error, "Sign-out failed.");
};
