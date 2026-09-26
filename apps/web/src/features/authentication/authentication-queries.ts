import { queryOptions } from "@tanstack/react-query";
import { getBrowserAuthenticationConfiguration } from "./authentication-requests.js";

export const authenticationModeQueryOptions = queryOptions({
  queryKey: ["authentication-mode"],
  queryFn: getBrowserAuthenticationConfiguration,
  staleTime: Number.POSITIVE_INFINITY,
});
