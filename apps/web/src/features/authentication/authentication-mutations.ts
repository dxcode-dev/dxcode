import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { authenticationModeQueryOptions } from "./authentication-queries.js";
import {
  getBrowserAuthenticationConfiguration,
  requestMagicLink,
} from "./authentication-requests.js";
import { requestTurnstileToken } from "./turnstile.js";

export const accessRequestNotice =
  "Check your email for a sign-in link. If one doesn’t arrive, your address is on the waitlist.";

/** Shared mutation for landing enrollment and protected-route sign-in. */
export function useAccessRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    // Admission changes no browser-readable server state; auth mode is deployment-static.
    onSuccess: () =>
      queryClient.setQueryData(
        authenticationModeQueryOptions.queryKey,
        (mode) => mode,
      ),
    mutationFn: async ({
      email,
      container,
      callbackURL,
    }: {
      email: string;
      container: HTMLElement;
      callbackURL?: string;
    }) => {
      const configuration = await getBrowserAuthenticationConfiguration();
      if (configuration.mode !== "magic-link")
        throw new Error(
          "Email early access is available on hosted DX. Use local sign-in for development.",
        );
      if (!configuration.turnstileSiteKey)
        throw new Error(
          "Sign-in protection is not configured. Please try again later.",
        );
      const token = await requestTurnstileToken(
        container,
        configuration.turnstileSiteKey,
      );
      return await Effect.runPromise(
        requestMagicLink(email, token, callbackURL),
      );
    },
    retry: false,
  });
}
