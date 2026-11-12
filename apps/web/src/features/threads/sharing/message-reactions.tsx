import type { MessageReaction, ThreadDetailData } from "@dx/api";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import type { ReactionCount } from "../../../shared/reactions/reaction-set.js";
import type { TranscriptRow } from "../transcript-view-model.js";
import {
  messageReactionsQueryOptions,
  reactedMessageId,
  threadTakesReactions,
  useSetMessageReaction,
} from "./message-reactions-queries.js";

/**
 * Reactions on a shared Thread's messages, as a Space's posts take them
 * (`@dx/api` message-reactions.ts): chips under a person's message or the
 * agent's answer, and an Add Reaction button beside its ⋯. A private Thread
 * shows none. The agent neither sees nor gives them.
 */

interface MessageReactionsValue {
  /** The viewer may react: the Thread is shared and not archived. */
  readonly canReact: boolean;
  readonly byMessage: ReadonlyMap<string, ReadonlyArray<ReactionCount>>;
  readonly toggle: (
    messageId: string,
    reaction: MessageReaction,
    on: boolean,
  ) => void;
}

const MessageReactionsContext = React.createContext<
  MessageReactionsValue | undefined
>(undefined);

const NO_REACTIONS: ReadonlyArray<ReactionCount> = [];

function SharedThreadReactions({
  thread,
  children,
}: {
  readonly thread: ThreadDetailData;
  readonly children: React.ReactNode;
}) {
  const { identity } = useAuthenticatedIdentity();
  const query = useQuery(messageReactionsQueryOptions(identity.id, thread.id));
  const mutation = useSetMessageReaction(identity.id, thread.id);
  const { mutate } = mutation;
  const items = query.data?.shared === true ? query.data.items : undefined;
  const value = React.useMemo<MessageReactionsValue>(
    () => ({
      canReact: thread.lifecycleState === "active",
      byMessage: new Map(
        (items ?? []).map(({ messageId, reactions }) => [messageId, reactions]),
      ),
      toggle: (messageId, reaction, on) => mutate({ messageId, reaction, on }),
    }),
    [items, mutate, thread.lifecycleState],
  );
  return (
    <MessageReactionsContext value={value}>{children}</MessageReactionsContext>
  );
}

/** Offers reactions on the transcript's messages while the Thread is shared. */
export function ThreadMessageReactions({
  thread,
  children,
}: {
  readonly thread: ThreadDetailData;
  readonly children: React.ReactNode;
}) {
  return threadTakesReactions(thread) ? (
    <SharedThreadReactions thread={thread}>{children}</SharedThreadReactions>
  ) : (
    children
  );
}

/** A row's reactions and how to toggle them. */
export interface RowReactions {
  readonly canReact: boolean;
  readonly reactions: ReadonlyArray<ReactionCount>;
  readonly toggle: (reaction: MessageReaction, on: boolean) => void;
}

/** The row's reactions and how to toggle them; undefined when it takes none. */
const useRowReactions = (row: TranscriptRow): RowReactions | undefined => {
  const context = React.use(MessageReactionsContext);
  const messageId = reactedMessageId(row);
  if (context === undefined || messageId === undefined) return undefined;
  return {
    canReact: context.canReact,
    reactions: context.byMessage.get(messageId) ?? NO_REACTIONS,
    toggle: (reaction: MessageReaction, on: boolean) =>
      context.toggle(messageId, reaction, on),
  };
};

const Controls = React.lazy(() => import("./message-reaction-controls.js"));

/** Add Reaction, beside the message's ⋯; loads with the first shared Thread. */
export function MessageReactionAction({
  row,
}: {
  readonly row: TranscriptRow;
}) {
  const reactions = useRowReactions(row);
  if (reactions === undefined || !reactions.canReact) return null;
  return (
    <React.Suspense fallback={null}>
      <Controls part="action" reactions={reactions} />
    </React.Suspense>
  );
}

/** The message's reaction chips, under it. */
export function MessageReactionChips({
  row,
  side,
}: {
  readonly row: TranscriptRow;
  readonly side: "left" | "right";
}) {
  const reactions = useRowReactions(row);
  if (reactions === undefined || reactions.reactions.length === 0) return null;
  return (
    <React.Suspense fallback={null}>
      <Controls part="chips" side={side} reactions={reactions} />
    </React.Suspense>
  );
}
