import { apiKeyClient } from "@better-auth/api-key/client";
import { createAuthClient } from "better-auth/react";
import { Effect, Schema } from "effect";
import { useSyncExternalStore } from "react";

export const BROWSER_SESSION_REFETCH_INTERVAL_SECONDS = 60 * 60 + 15;

let browserSessionResolved = false;
const browserSessionResolutionListeners = new Set<() => void>();
const markBrowserSessionResolved = () => {
  if (browserSessionResolved) return;
  browserSessionResolved = true;
  for (const listener of browserSessionResolutionListeners) listener();
};
const subscribeToBrowserSessionResolution = (listener: () => void) => {
  browserSessionResolutionListeners.add(listener);
  return () => browserSessionResolutionListeners.delete(listener);
};

const authClient = createAuthClient({
  basePath: "/api/auth",
  plugins: [apiKeyClient()],
  sessionOptions: {
    refetchInterval: BROWSER_SESSION_REFETCH_INTERVAL_SECONDS,
    refetchOnWindowFocus: true,
    refetchWhenOffline: false,
    onSuccess: markBrowserSessionResolved,
    onError: markBrowserSessionResolved,
  },
});

export class BrowserAuthError extends Schema.TaggedError<BrowserAuthError>()(
  "BrowserAuthError",
  { message: Schema.String },
) {}

const browserAuthError = (fallback: string) => (cause: unknown) =>
  new BrowserAuthError({
    message: cause instanceof Error ? cause.message : fallback,
  });

export const useBrowserSession = () => {
  const session = authClient.useSession();
  const hasResolved = useSyncExternalStore(
    subscribeToBrowserSessionResolution,
    () => browserSessionResolved,
    () => false,
  );
  return { ...session, hasResolved };
};

export const signOut = Effect.tryPromise({
  try: async () => {
    const result = await authClient.signOut();
    if (result.error !== null) throw result.error;
  },
  catch: browserAuthError("Sign-out failed."),
});

export const signInWithEmail = (input: {
  readonly email: string;
  readonly password: string;
}) =>
  Effect.tryPromise({
    try: async () => {
      const result = await authClient.signIn.email(input);
      if (result.error !== null) throw new Error(result.error.message);
    },
    catch: browserAuthError("Email sign-in failed."),
  });

export const signUpWithEmail = (input: {
  readonly name: string;
  readonly email: string;
  readonly password: string;
}) =>
  Effect.tryPromise({
    try: async () => {
      const result = await authClient.signUp.email(input);
      if (result.error !== null) throw new Error(result.error.message);
    },
    catch: browserAuthError("Account creation failed."),
  });
