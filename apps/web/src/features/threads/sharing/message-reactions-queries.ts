import type {
  ListMessageReactionsResponseSchema,
  ThreadDetailData,
} from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import {
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { THREAD_FRESHNESS_SLO_MS } from "../thread-queries.js";
import type { TranscriptRow } from "../transcript-view-model.js";
import { messageReactionKeys } from "./message-reactions-cache-queries.js";
import type { MessageReactionInput } from "./message-reactions-request-queries.js";

// A shared Thread's message reactions: their requests (`@dx/api`
// message-reactions.ts) and which rows take them.

/** Whether a Thread's messages take reactions: shared, and not a Space. */
export const threadTakesReactions = (thread: ThreadDetailData) =>
  thread.sharing !== undefined && thread.kind !== "space";

/**
 * The Flue history id (`entry_…`) a row's reactions sit on: a person's
 * message once Flue holds it, or the agent's answer. Other rows take none.
 * Core checks the full form (`REACTED_MESSAGE_ID_PATTERN`), whose module
 * stays out of the Thread page's first load.
 */
export const reactedMessageId = (row: TranscriptRow) => {
  const id =
    row.kind === "user-prompt"
      ? row.admitted
        ? (row.flueMessageId ?? row.messageId)
        : undefined
      : row.kind === "final-answer" && !row.streaming
        ? row.messageId
        : undefined;
  return id?.startsWith("entry_") === true ? id : undefined;
};

type ReactionList = (typeof ListMessageReactionsResponseSchema.Type)["data"];

/** The requests, loaded with the first shared Thread's reactions. */
const requests = () => import("./message-reactions-request-queries.js");

export const messageReactionsQueryOptions = (
  userId: UserId,
  threadId: ThreadId,
) =>
  queryOptions({
    queryKey: messageReactionKeys.thread(userId, threadId),
    queryFn: async ({ signal }) =>
      (await requests()).listMessageReactions(threadId, signal),
    staleTime: 10_000,
    // Realtime refreshes them as they change; this covers a missed hint.
    refetchInterval: THREAD_FRESHNESS_SLO_MS,
    refetchIntervalInBackground: false,
  });

/** Gives or takes back the viewer's reaction; the chip changes at once. */
export const useSetMessageReaction = (userId: UserId, threadId: ThreadId) => {
  const client = useQueryClient();
  const key = messageReactionKeys.thread(userId, threadId);
  return useMutation({
    mutationKey: [...key, "react"],
    mutationFn: async (input: MessageReactionInput) =>
      (await requests()).setMessageReaction(threadId, input),
    onMutate: async (input) => {
      const { withToggledReaction } = await requests();
      await client.cancelQueries({ queryKey: key });
      client.setQueryData<ReactionList>(key, (list) =>
        withToggledReaction(list, input),
      );
    },
    onSuccess: async (next) => {
      const { withMessageReactions } = await requests();
      client.setQueryData<ReactionList>(key, (list) =>
        withMessageReactions(list, next),
      );
    },
    onError: () => client.invalidateQueries({ queryKey: key }),
  });
};
