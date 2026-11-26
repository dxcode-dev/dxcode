import {
  AddMessageReactionEndpoint,
  ListMessageReactionsEndpoint,
  type ListMessageReactionsResponseSchema,
  type MessageReaction,
  type MessageReactions,
  RemoveMessageReactionEndpoint,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { dxClient } from "../../../shared/api/client.js";
import { toggledReactions } from "../../../shared/reactions/reaction-set.js";

// A shared Thread's message reactions on the wire, and how a change lands in
// the cached list. Loaded on first use (`message-reactions-queries.ts`), so
// a private Thread's page never carries it.

type ReactionList = (typeof ListMessageReactionsResponseSchema.Type)["data"];

export interface MessageReactionInput {
  readonly messageId: string;
  readonly reaction: MessageReaction;
  readonly on: boolean;
}

export const listMessageReactions = async (
  threadId: ThreadId,
  signal?: AbortSignal,
) =>
  (
    await dxClient.call(
      ListMessageReactionsEndpoint,
      { params: { threadId } },
      { signal },
    )
  ).data;

export const setMessageReaction = async (
  threadId: ThreadId,
  input: MessageReactionInput,
) =>
  (
    await dxClient.call(
      input.on ? AddMessageReactionEndpoint : RemoveMessageReactionEndpoint,
      {
        params: {
          threadId,
          messageId: input.messageId,
          reaction: input.reaction,
        },
      },
    )
  ).data;

/** The list with one message's reactions as the server now has them. */
export const withMessageReactions = (
  list: ReactionList | undefined,
  next: MessageReactions,
): ReactionList | undefined =>
  list === undefined
    ? list
    : {
        ...list,
        items: [
          ...list.items.filter(({ messageId }) => messageId !== next.messageId),
          next,
        ],
      };

/** The list with the viewer's reaction toggled, as the server will. */
export const withToggledReaction = (
  list: ReactionList | undefined,
  input: MessageReactionInput,
) =>
  withMessageReactions(list, {
    messageId: input.messageId,
    reactions: toggledReactions(
      list?.items.find(({ messageId }) => messageId === input.messageId)
        ?.reactions ?? [],
      input.reaction,
      input.on,
    ),
  });
