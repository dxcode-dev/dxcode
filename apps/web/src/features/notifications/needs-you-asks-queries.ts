import {
  type NeedsYouAsk,
  NeedsYouAsksResponseSchema,
  TickNeedsYouAskResponseSchema,
} from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { request } from "../../shared/api/client.js";
import { invalidateNeedsYou, needsYouKeys } from "./needs-you-queries.js";

// Only the Needs-you page reads asks, so they stay out of the Thread page's
// first load (the sidebar inbox imports needs-you-queries).
/** Asks in artifacts (`artifact-asks` flag): open checklist items that mention the person. */
const listNeedsYouAsks = async (signal?: AbortSignal) =>
  (await request("/v1/needs-you/asks", NeedsYouAsksResponseSchema, { signal }))
    .data.asks;

const tickNeedsYouAsk = async (ask: {
  readonly threadId: ThreadId;
  readonly artifactId: string;
  readonly itemKey: string;
}) =>
  (
    await request("/v1/needs-you/asks/tick", TickNeedsYouAskResponseSchema, {
      method: "POST",
      body: JSON.stringify(ask),
    })
  ).data;

/**
 * Under the list's key, so the realtime `needs-you.invalidated` refresh that
 * a save sends whoever gained or lost an ask refetches it too.
 */
export const needsYouAsksQueryOptions = (userId: UserId, enabled: boolean) =>
  queryOptions({
    queryKey: [...needsYouKeys.list(userId), "asks"] as const,
    queryFn: ({ signal }) => listNeedsYouAsks(signal),
    enabled,
    staleTime: 30_000,
    refetchInterval: 120_000,
    refetchOnWindowFocus: true,
  });

/** Ticks an ask; it leaves the list at once and its Thread wakes. */
export const tickNeedsYouAskMutationOptions = (
  client: QueryClient,
  userId: UserId,
) =>
  mutationOptions({
    mutationKey: [...needsYouKeys.list(userId), "asks", "tick"] as const,
    mutationFn: (ask: NeedsYouAsk) =>
      tickNeedsYouAsk({
        threadId: ask.threadId,
        artifactId: ask.artifactId,
        itemKey: ask.itemKey,
      }),
    onMutate: async (ask) => {
      const key = [...needsYouKeys.list(userId), "asks"] as const;
      await client.cancelQueries({ queryKey: key });
      client.setQueryData<ReadonlyArray<NeedsYouAsk>>(key, (current) =>
        current?.filter(
          (item) =>
            !(
              item.artifactId === ask.artifactId && item.itemKey === ask.itemKey
            ),
        ),
      );
    },
    onSettled: () => invalidateNeedsYou(client, userId),
  });
