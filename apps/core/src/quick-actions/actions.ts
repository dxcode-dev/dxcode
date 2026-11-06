import { REPLY_OFFER_LIMIT, type ThreadQuickAction } from "@dx/api";
import type { Bindings } from "../http/types.js";
import { agentModelLogger } from "../logging.js";
import { plainPreview } from "../notifications/plain-preview.js";
import {
  finalReplyText,
  type HistoryMessage,
  type HistoryPage,
} from "../thread-search/history.js";
import { type ClefCall, runClef } from "../workers-ai/clef.js";

/**
 * Composer quick actions (#1558, experimental): when the agent ends a turn,
 * dx lists the actions it could offer, and one call to Clef Flash on
 * Workers AI scores how likely each is to be the person's next step after
 * the agent's last message. The row shows the ones Clef does not rule out,
 * most likely first. Clef writes no text: each action is dx's own, or a
 * reply a small text model wrote from the agent's final reply
 * (`reply-writer.ts`). The agent is never told.
 */

/** Only Clef Flash, Workers AI's fast Clef. */
export const QUICK_ACTIONS_MODEL = {
  model: "@cf/cloudflare/clef-flash",
  selector: "clef-flash",
} as const;

/** What Clef reads of the agent's last message: its end, where it asks. */
const SUMMARY_LIMIT = 2_000;

/** Lowest first, as Clef's score rubric reads them; 0 hides the action. */
const FIT = [
  "Unlikely: the person would not take this step now, so do not offer it",
  "Possible next step",
  "Likely next step",
  "The most likely next step",
];

/** The agent's latest response, when it ended the Thread's last turn. */
export interface EndedTurn {
  readonly messageId: string;
  /** What the agent said last, as plain text, shortened. */
  readonly summary: string;
  /** The agent's final reply as Markdown, for the reply writer. */
  readonly reply: string;
}

/**
 * The agent's response that ends the history, if it ended the turn
 * `submissionId` and that turn completed. A newer message from anyone, a
 * failed or stopped turn, or a response still streaming ends nothing yet.
 * The turn end hook names its own submission, which it knows completed.
 */
export const endedTurn = (
  page: HistoryPage,
  submissionId?: string,
): EndedTurn | undefined => {
  const last = page.messages.findLast(
    (message: HistoryMessage) => message.role !== "system",
  );
  if (
    last === undefined ||
    last.role !== "assistant" ||
    last.purpose !== "assistant" ||
    last.submissionId === undefined ||
    (submissionId === undefined
      ? page.settled.get(last.submissionId) !== "completed"
      : last.submissionId !== submissionId ||
        (page.settled.get(submissionId) ?? "completed") !== "completed")
  )
    return undefined;
  const reply = finalReplyText(last.parts ?? []);
  return {
    messageId: last.id,
    summary: plainPreview(reply).slice(-SUMMARY_LIMIT),
    reply,
  };
};

/** Runs one Clef call; never rejects. Tests replace it. */
export type QuickActionsCaller = (input: {
  readonly bindings: Bindings;
  readonly state: unknown;
  readonly questions: Record<string, unknown>;
}) => Promise<ClefCall>;

export const workersAiQuickActions: QuickActionsCaller = async ({
  bindings,
  state,
  questions,
}) => {
  try {
    return await runClef({
      bindings,
      ...QUICK_ACTIONS_MODEL,
      state,
      questions,
    });
  } catch (cause) {
    agentModelLogger.warn("Composer quick actions call failed.", {
      event: "quick_actions_call_failed",
      cause,
    });
    return { ok: false };
  }
};

const describe = (action: ThreadQuickAction) =>
  action.kind === "snooze"
    ? {
        kind: "snooze",
        does: "Hides this Thread until its agent next finishes a turn, so the person can stop watching it",
      }
    : { kind: "reply", sends: action.text };

/**
 * The actions to show after `turn`, most likely first: the candidates Clef
 * scored above "unlikely", at most `REPLY_OFFER_LIMIT` of them replies.
 * Undefined when Clef did not answer usably: the row then shows nothing
 * rather than a guess.
 */
export const chooseQuickActions = async (
  call: QuickActionsCaller,
  bindings: Bindings,
  turn: EndedTurn,
  replies: ReadonlyArray<string>,
  canSnooze: boolean,
): Promise<ReadonlyArray<ThreadQuickAction> | undefined> => {
  const candidates: ReadonlyArray<ThreadQuickAction> = [
    ...replies.map((text) => ({ kind: "reply" as const, text })),
    ...(canSnooze ? [{ kind: "snooze" as const }] : []),
  ];
  if (candidates.length === 0) return [];
  const aliases = candidates.map((_, index) => `a${index + 1}`);
  const result = await call({
    bindings,
    state: {
      setting:
        "A person just read an AI coding agent's last message in a Thread. Above the message box dx can offer a few one-click actions. Each reply is sent as the person's next message; a small model wrote it from the agent's message, so it may not fit.",
      lastAgentMessage:
        turn.summary === "" ? "(The agent ended without text.)" : turn.summary,
      actions: candidates.map((action, index) => ({
        action: aliases[index],
        ...describe(action),
      })),
    },
    questions: Object.fromEntries(
      aliases.map((alias) => [
        `${alias}.fit`,
        {
          type: "score",
          instructions: {
            question:
              "How likely is this action to be the person's next step after reading the agent's last message?",
            action: alias,
          },
          criteria: FIT,
        },
      ]),
    ),
  });
  if (!result.ok) return undefined;
  const scored = candidates.map((action, index) => ({
    action,
    index,
    fit: fitOf(result.answers[`a${index + 1}.fit`]),
  }));
  if (scored.every(({ fit }) => fit === undefined)) return undefined;
  return scored
    .filter(
      (scored): scored is typeof scored & { fit: number } =>
        scored.fit !== undefined && Math.round(scored.fit) >= 1,
    )
    .sort((a, b) => b.fit - a.fit || a.index - b.index)
    .map(({ action }) => action)
    .filter(
      (action, _, kept) =>
        action.kind !== "reply" ||
        kept.filter(({ kind }) => kind === "reply").indexOf(action) <
          REPLY_OFFER_LIMIT,
    );
};

const FIT_TOP = FIT.length - 1;

/** A score in the rubric's range, or undefined. */
const fitOf = (answer: unknown) => {
  const value = answer as { type?: unknown; score?: unknown } | null;
  return value?.type === "score" &&
    typeof value.score === "number" &&
    Number.isFinite(value.score) &&
    value.score >= 0 &&
    value.score <= FIT_TOP
    ? value.score
    : undefined;
};
