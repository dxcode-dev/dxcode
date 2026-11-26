import { queryOptions } from "@tanstack/react-query";
import { sameOriginFetch } from "../../shared/same-origin-fetch.js";

/**
 * A one-time code that hands this browser's session to a dx app, bound to
 * the app's PKCE challenge: Core's `native-handoff/create`. A plain request,
 * not through the Better Auth client, whose module every page loads first.
 */
const createNativeHandoff = async (challenge: string) => {
  const response = await sameOriginFetch("/api/auth/native-handoff/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ challenge }),
  });
  const body: unknown = await response.json().catch(() => undefined);
  const field = (name: string) =>
    typeof body === "object" && body !== null && name in body
      ? (body as Record<string, unknown>)[name]
      : undefined;
  const code = field("code");
  if (response.ok && typeof code === "string") return code;
  const message = field("message");
  throw new Error(
    typeof message === "string" && message.length > 0
      ? message
      : "dx couldn't hand this sign-in to the app. Try again.",
  );
};

/**
 * The browser half of signing in to a dx app: a one-time code for the app's
 * challenge, then the app's own URL with it (`<app>://auth?host=…&code=…&
 * state=…`), which the browser opens. One per visit: never refetched.
 */
export const nativeHandoffQueryOptions = (input: {
  readonly app: string;
  readonly state: string;
  readonly challenge: string;
}) =>
  queryOptions({
    queryKey: ["native-handoff", input.app, input.state, input.challenge],
    queryFn: async () => {
      const code = await createNativeHandoff(input.challenge);
      const link = `${input.app}://auth?${new URLSearchParams({
        host: window.location.host,
        code,
        state: input.state,
      }).toString()}`;
      window.location.assign(link);
      return link;
    },
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
