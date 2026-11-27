import {
  type ThreadDetailData,
  type ThreadQueuedMessage,
  withMessageAuthor,
} from "@dx/api";
import {
  deriveTranscriptViewModel,
  INBOUND_MESSAGE_PREFIX,
  type TranscriptViewModel,
} from "@dx/transcript";
import type {
  FlueConversationFinalOutput,
  FlueConversationMessage,
} from "@flue/sdk";
import {
  type SentMessagesAgent,
  withoutDroppedSends,
  withoutUnsentEchoes,
  withoutWithdrawn,
  withQueuedMessages,
} from "./sent-messages.js";

/**
 * What a transcript shows, from a Flue agent snapshot and the dx data beside
 * it: the inputs `deriveTranscriptViewModel` takes, gathered the same way in
 * every UI, and a derivation that runs once per snapshot and view.
 */

/** A message another Thread sent while this one worked, not yet joined. */
export type InboundMessage = NonNullable<
  ThreadDetailData["inboundMessages"]
>[number];

/** Stands in for a pending message's text, which only Flue holds. */
const PENDING_INBOUND_TEXT = "…";

/**
 * A message another Thread sent while this one worked reaches Flue's history
 * only when it joins the turn. Until then a row shows that one is on its way
 * from its source Thread, after the history; its text arrives with Flue.
 */
export const withInboundMessages = (
  messages: FlueConversationMessage[],
  inbound: ReadonlyArray<InboundMessage> | undefined,
  olderHistory: boolean,
): FlueConversationMessage[] => {
  if (inbound === undefined || inbound.length === 0) return messages;
  const joined = new Set(
    messages.flatMap(({ submissionId }) =>
      submissionId === undefined ? [] : [submissionId],
    ),
  );
  // Flue joins waiting messages in order. One older than the oldest loaded
  // prompt has joined already, into history not loaded yet.
  const oldestLoadedPrompt = olderHistory
    ? Math.min(
        ...messages.flatMap((message) => {
          const at = Date.parse(
            String(message.timestamp ?? message.metadata?.timestamp ?? ""),
          );
          return message.role === "user" &&
            message.submissionId !== undefined &&
            !Number.isNaN(at)
            ? [at]
            : [];
        }),
      )
    : Number.NEGATIVE_INFINITY;
  const pending = inbound.filter(
    ({ submissionId, createdAt }) =>
      !joined.has(submissionId) && Date.parse(createdAt) >= oldestLoadedPrompt,
  );
  if (pending.length === 0) return messages;
  return [
    ...messages,
    ...pending.map(
      ({ submissionId, sourceThreadId }) =>
        ({
          id: `${INBOUND_MESSAGE_PREFIX}${submissionId}`,
          role: "user",
          purpose: "user",
          display: "visible",
          parts: [
            {
              type: "text",
              text: withMessageAuthor(
                {
                  author: { role: "owner", userId: "thread", name: "Thread" },
                  sourceThreadId,
                },
                PENDING_INBOUND_TEXT,
              ),
              state: "done",
            },
          ],
        }) as FlueConversationMessage,
    ),
  ];
};

/** The parts of a Flue agent snapshot a transcript derives from. */
export interface TranscriptAgent extends SentMessagesAgent {
  readonly finalOutputs: FlueConversationFinalOutput[];
  readonly historyReady: boolean;
  /** Older history exists that is not loaded. */
  readonly hasMore?: boolean;
}

/** What the transcript leaves out or adds to Flue's history. */
export interface TranscriptView {
  readonly discardedSends: ReadonlySet<string>;
  /** The latest send is not confirmed; its echo stays in the composer. */
  readonly unconfirmed: boolean;
  readonly inboundMessages: ReadonlyArray<InboundMessage> | undefined;
  /** The viewer's own messages waiting in the queue, from the server. */
  readonly queuedMessages: ReadonlyArray<ThreadQueuedMessage> | undefined;
  readonly chatEcho: ((text: string) => boolean) | undefined;
  readonly admittedMessageId:
    | ((submissionId: string) => string | undefined)
    | undefined;
}

export const NO_DISCARDED_SENDS: ReadonlySet<string> = new Set();

/**
 * The view of a history window opened at an older prompt: it shows no
 * discarded, queued, or inbound sends, which belong after the live history.
 */
export const historyWindowView = (view: TranscriptView): TranscriptView => ({
  discardedSends: NO_DISCARDED_SENDS,
  unconfirmed: false,
  inboundMessages: undefined,
  queuedMessages: undefined,
  chatEcho: view.chatEcho,
  admittedMessageId: view.admittedMessageId,
});

export interface ShownTranscript<Agent extends TranscriptAgent> {
  /** The snapshot without the sends the transcript leaves out. */
  readonly agent: Agent;
  readonly model: TranscriptViewModel;
}

export const EMPTY_TRANSCRIPT: TranscriptViewModel = deriveTranscriptViewModel({
  messages: [],
  settlements: [],
});

export interface TranscriptDerivation<Agent extends TranscriptAgent> {
  readonly derive: (
    observed: Agent,
    view: TranscriptView,
  ) => ShownTranscript<Agent>;
  /** The latest model, for an export. */
  readonly current: () => TranscriptViewModel;
}

/**
 * Derives the shown transcript once per Flue snapshot and view, shared by
 * the transcript and the run state. Each derivation reuses the previous
 * model's unchanged turns and rows, so a streamed frame rebuilds only what
 * changed; `current` reads the latest model for an export.
 */
export const createTranscriptDerivation = <
  Agent extends TranscriptAgent,
>(): TranscriptDerivation<Agent> => {
  let last:
    | {
        readonly agent: Agent;
        readonly view: TranscriptView;
        readonly shown: ShownTranscript<Agent>;
      }
    | undefined;
  let model: TranscriptViewModel | undefined;
  let modelInputs: ReadonlyArray<unknown> = [];
  const sameView = (previous: TranscriptView, next: TranscriptView) =>
    previous.discardedSends === next.discardedSends &&
    previous.unconfirmed === next.unconfirmed &&
    previous.inboundMessages === next.inboundMessages &&
    previous.queuedMessages === next.queuedMessages &&
    previous.chatEcho === next.chatEcho &&
    previous.admittedMessageId === next.admittedMessageId;
  const derive = (
    observed: Agent,
    view: TranscriptView,
  ): ShownTranscript<Agent> => {
    if (
      last !== undefined &&
      last.agent === observed &&
      sameView(last.view, view)
    )
      return last.shown;
    const agent = withoutUnsentEchoes(
      withoutDroppedSends(observed, view.discardedSends),
      view.unconfirmed,
    );
    const inputs = [
      agent.messages,
      agent.settlements,
      agent.finalOutputs,
      agent.historyReady,
      agent.hasMore,
      view.inboundMessages,
      view.queuedMessages,
      agent.localSubmissions,
      view.chatEcho,
      view.admittedMessageId,
    ];
    if (
      model === undefined ||
      inputs.some((input, index) => input !== modelInputs[index])
    ) {
      model = deriveTranscriptViewModel(
        {
          // After history loads: a pending message ahead of it would move
          // once history arrives.
          messages: agent.historyReady
            ? withQueuedMessages(
                withInboundMessages(
                  agent.messages,
                  view.inboundMessages,
                  agent.hasMore === true,
                ),
                view.queuedMessages,
                agent.localSubmissions,
              )
            : agent.messages,
          // A withdrawn message ran nothing; it shows no stopped turn.
          settlements: withoutWithdrawn(agent).settlements,
          finalOutputs: agent.finalOutputs,
          chatEcho: view.chatEcho,
          admittedMessageId: view.admittedMessageId,
        },
        model,
      );
      modelInputs = inputs;
    }
    const shown = { agent, model };
    last = { agent: observed, view, shown };
    return shown;
  };
  return { derive, current: () => model ?? EMPTY_TRANSCRIPT };
};
