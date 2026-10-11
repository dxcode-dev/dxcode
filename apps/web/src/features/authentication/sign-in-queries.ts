import { queryOptions } from "@tanstack/react-query";
import {
  getBrowserSession,
  getSignInOptions,
} from "../../shared/auth/auth-client.js";

const SIGNED_IN_REFRESH_MS = (60 * 60 + 15) * 1000;

/**
 * The browser session. Query keeps the last answer while it refetches, so a
 * focus or reconnect refetch never unmounts the signed-out page.
 */
export const sessionQueryOptions = queryOptions({
  queryKey: ["auth", "session"],
  queryFn: getBrowserSession,
  staleTime: 60_000,
  refetchInterval: (query) => (query.state.data ? SIGNED_IN_REFRESH_MS : false),
});

/** Deployment-static: the providers and admission policy this deployment offers. */
export const signInOptionsQueryOptions = queryOptions({
  queryKey: ["auth", "sign-in-options"],
  queryFn: getSignInOptions,
  staleTime: Number.POSITIVE_INFINITY,
  refetchOnWindowFocus: false,
});
