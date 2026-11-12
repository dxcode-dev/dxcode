import { queryOptions } from "@tanstack/react-query";
import { type HuddleScope, huddleScopeKey } from "./huddle-client.js";
import { huddleClient } from "./huddle-session.js";

export const huddleKeys = {
  all: ["huddle"] as const,
  summary: (scope: HuddleScope) =>
    ["huddle", "summary", huddleScopeKey(scope)] as const,
};

/** Who is in a Space's or thread's huddle, polled while its header shows. */
export const huddleSummaryQueryOptions = (scope: HuddleScope) =>
  queryOptions({
    queryKey: huddleKeys.summary(scope),
    queryFn: ({ signal }) => huddleClient.fetchSummary(scope, signal),
    staleTime: 10_000,
    refetchInterval: 15_000,
  });
