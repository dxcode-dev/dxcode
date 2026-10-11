import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  requestMagicLink,
  signInWithGoogle,
  signInWithPassword,
  signOut,
  signUpWithPassword,
} from "../../shared/auth/auth-client.js";
import {
  sessionQueryOptions,
  signInOptionsQueryOptions,
} from "./sign-in-queries.js";
import { requestTurnstileToken } from "./turnstile.js";

interface ProtectedRequest {
  /** Where an invisible Turnstile challenge may render when one is needed. */
  readonly challenge: HTMLElement | null;
}

/** A fresh Turnstile token when the deployment protects this request, even if the form was submitted before options loaded. */
const useTurnstileToken = () => {
  const queryClient = useQueryClient();
  return async ({ challenge }: ProtectedRequest) => {
    const { turnstileSiteKey } = await queryClient.ensureQueryData(
      signInOptionsQueryOptions,
    );
    if (turnstileSiteKey === undefined) return undefined;
    if (challenge === null) throw new Error("Please try again.");
    return requestTurnstileToken(challenge, turnstileSiteKey);
  };
};

/** Sends a sign-in link, or reports that the address is on the waitlist. */
export function useMagicLinkRequest() {
  const turnstileToken = useTurnstileToken();
  // Sending a link or joining the waitlist changes no cached query; the
  // session changes only when the emailed link opens in a new page load.
  // react-doctor-disable-next-line react-doctor/query-mutation-missing-invalidation
  return useMutation({
    mutationFn: async (
      input: ProtectedRequest & {
        readonly email: string;
        readonly callbackURL: string;
        readonly errorCallbackURL: string;
      },
    ) => {
      const outcome = await requestMagicLink({
        email: input.email,
        callbackURL: input.callbackURL,
        errorCallbackURL: input.errorCallbackURL,
        turnstileToken: await turnstileToken(input),
      });
      return { email: input.email, outcome };
    },
  });
}

export function usePasswordSignIn() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      readonly email: string;
      readonly password: string;
      readonly callbackURL: string;
    }) => {
      await signInWithPassword(input);
      return { email: input.email };
    },
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: sessionQueryOptions.queryKey,
      }),
  });
}

export function usePasswordSignUp() {
  const queryClient = useQueryClient();
  const turnstileToken = useTurnstileToken();
  return useMutation({
    mutationFn: async (
      input: ProtectedRequest & {
        readonly name: string;
        readonly email: string;
        readonly password: string;
        readonly callbackURL: string;
      },
    ) => {
      const result = await signUpWithPassword({
        name: input.name,
        email: input.email,
        password: input.password,
        callbackURL: input.callbackURL,
        turnstileToken: await turnstileToken(input),
      });
      return { email: input.email, result };
    },
    onSuccess: ({ result }) =>
      result === "signed-in"
        ? queryClient.invalidateQueries({
            queryKey: sessionQueryOptions.queryKey,
          })
        : undefined,
  });
}

/** Leaves the page for Google; the callback returns to `callbackURL` or `errorCallbackURL`. */
export function useGoogleSignIn() {
  // The browser leaves for Google; the callback is a new page load.
  // react-doctor-disable-next-line react-doctor/query-mutation-missing-invalidation
  return useMutation({ mutationFn: signInWithGoogle });
}

export function useSignOut(onSignedOut: () => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: signOut,
    onSuccess: () => {
      onSignedOut();
      queryClient.setQueryData(sessionQueryOptions.queryKey, null);
    },
  });
}
