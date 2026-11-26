import { type ThreadQueuedMessage, withMessageAttachments } from "@dx/api";
import type {
  FlueConversationMessage,
  FlueConversationSettlement,
} from "@flue/sdk";
import { sendRefusal } from "../threads/send-refusal.js";
import type { UserPromptRow } from "./message-edit-model.js";
import { isWithdrawnSettlement } from "./withdrawn-sends.js";

/**
 * What a transcript shows of the viewer's own sends beside Flue's history:
 * messages waiting in the server's queue, this tab's echoes, and sends that
 * failed, were refused, or were withdrawn. Pure functions over a Flue agent
 * snapshot, so every UI shows the same rows.
 */

/** A send this client made: its echo's local id and the server's submission. */
export interface LocalSubmission {
  readonly localId: string;
  readonly submissionId: string;
}

/** The parts of a Flue agent snapshot these filters read. */
export interface SentMessagesAgent {
  readonly messages: FlueConversationMessage[];
  readonly settlements: FlueConversationSettlement[];
  readonly failedSends: ReadonlyArray<{
    readonly id: string;
    readonly error: Error;
  }>;
  readonly error: Error | undefined;
  readonly localSubmissions?: ReadonlyArray<LocalSubmission>;
}

/**
 * A message the viewer sent from another tab or device that waits for the
 * agent: Flue's history gets it only when the agent reads it, so until then
 * a row shows it from the server's queue, after the history, where this
 * tab's own echoes wait too. Its id names its submission.
 */
export const QUEUED_MESSAGE_PREFIX = "queued:";

const queuedMessageRows = new WeakMap<
  ThreadQueuedMessage,
  FlueConversationMessage
>();

export const queuedMessage = (queued: ThreadQueuedMessage) => {
  const cached = queuedMessageRows.get(queued);
  if (cached !== undefined) return cached;
  const message = {
    id: `${QUEUED_MESSAGE_PREFIX}${queued.submissionId}`,
    role: "user",
    purpose: "user",
    display: "visible",
    parts: [{ type: "text", text: queued.original, state: "done" }],
  } as FlueConversationMessage;
  queuedMessageRows.set(queued, message);
  return message;
};

export const NO_LOCAL_SUBMISSIONS: ReadonlyArray<LocalSubmission> = [];

/**
 * This tab's echo of a waiting message, showing its text as the server's
 * queue holds it now: an edit replaces the text in place, from this tab or
 * another, while the echo keeps what was first sent.
 */
const queuedEchoes = new WeakMap<
  FlueConversationMessage,
  {
    readonly queued: ThreadQueuedMessage;
    readonly message: FlueConversationMessage;
  }
>();

const queuedEcho = (
  echo: FlueConversationMessage,
  queued: ThreadQueuedMessage,
) => {
  const cached = queuedEchoes.get(echo);
  if (cached?.queued === queued) return cached.message;
  const text = withMessageAttachments(queued.text, queued.attachments);
  const current = echo.parts.find((part) => part.type === "text");
  const message =
    current?.type === "text" && current.text === text
      ? echo
      : ({
          ...echo,
          parts: [
            { type: "text", text, state: "done" },
            ...echo.parts.filter((part) => part.type !== "text"),
          ],
        } as FlueConversationMessage);
  queuedEchoes.set(echo, { queued, message });
  return message;
};

export const withQueuedMessages = (
  messages: FlueConversationMessage[],
  queued: ReadonlyArray<ThreadQueuedMessage> | undefined,
  localSubmissions: ReadonlyArray<LocalSubmission> | undefined,
): FlueConversationMessage[] => {
  if (queued === undefined || queued.length === 0) return messages;
  const waitingBySubmission = new Map(
    queued.map((message) => [message.submissionId, message] as const),
  );
  const echoSubmission = new Map(
    (localSubmissions ?? []).map(
      ({ localId, submissionId }) => [localId, submissionId] as const,
    ),
  );
  // Shown already: read into Flue's history, or this tab's own echo.
  const shown = new Set(echoSubmission.values());
  let changed = false;
  const current = messages.map((message) => {
    if (message.submissionId !== undefined) {
      shown.add(message.submissionId);
      return message;
    }
    const submissionId = echoSubmission.get(message.id);
    const waiting =
      submissionId === undefined
        ? undefined
        : waitingBySubmission.get(submissionId);
    if (waiting === undefined) return message;
    const echo = queuedEcho(message, waiting);
    if (echo !== message) changed = true;
    return echo;
  });
  const waiting = queued.filter(({ submissionId }) => !shown.has(submissionId));
  if (waiting.length === 0) return changed ? current : messages;
  return [...current, ...waiting.map(queuedMessage)];
};

/** A message withdrawn from the queue settles aborted; no turn failed. */
export const withoutWithdrawn = <Agent extends SentMessagesAgent>(
  agent: Agent,
): Agent =>
  agent.settlements.some(isWithdrawnSettlement)
    ? {
        ...agent,
        settlements: agent.settlements.filter(
          (settlement) => !isWithdrawnSettlement(settlement),
        ),
      }
    : agent;

/** The submission a row waits under: this tab's echo, or a queued row. */
export const waitingSubmissionOf =
  (localSubmissions: ReadonlyArray<LocalSubmission>) =>
  (row: UserPromptRow) => {
    if (row.admitted) return undefined;
    if (row.messageId.startsWith(QUEUED_MESSAGE_PREFIX))
      return row.messageId.slice(QUEUED_MESSAGE_PREFIX.length);
    return localSubmissions.find(({ localId }) => localId === row.messageId)
      ?.submissionId;
  };

export const sameLocalSubmissions = (
  previous: ReadonlyArray<LocalSubmission>,
  next: ReadonlyArray<LocalSubmission>,
) =>
  previous === next ||
  (previous.length === next.length &&
    previous.every(
      (entry, index) =>
        entry.localId === next[index]?.localId &&
        entry.submissionId === next[index]?.submissionId,
    ));

/**
 * Flue keeps a failed echo for every rejected send and offers no discard. A
 * refused send is in the composer with its reason, and one an edited message
 * replaced is gone, so both leave the Retry card and the session error.
 */
export const keptSends = <Agent extends SentMessagesAgent>(
  agent: Agent,
  discarded: ReadonlySet<string>,
): Agent => {
  const dropped = agent.failedSends.filter(
    ({ id, error }) => discarded.has(id) || sendRefusal(error) !== undefined,
  );
  if (dropped.length === 0) return agent;
  const ids = new Set(dropped.map(({ id }) => id));
  return {
    ...agent,
    failedSends: agent.failedSends.filter(({ id }) => !ids.has(id)),
    error: dropped.some(({ error }) => error === agent.error)
      ? undefined
      : agent.error,
  };
};

/** Dropped sends also leave the transcript. */
export const withoutDroppedSends = <Agent extends SentMessagesAgent>(
  agent: Agent,
  discarded: ReadonlySet<string>,
): Agent => {
  const kept = keptSends(agent, discarded);
  if (kept === agent) return agent;
  const keptIds = new Set(kept.failedSends.map(({ id }) => id));
  const droppedIds = new Set(
    agent.failedSends.flatMap(({ id }) => (keptIds.has(id) ? [] : [id])),
  );
  return {
    ...kept,
    messages: agent.messages.filter(({ id }) => !droppedIds.has(id)),
  };
};

/**
 * Flue echoes a message into the transcript before the server has it. dx
 * shows a message once it is durable: until then, and after its send fails,
 * the composer holds it. So the transcript leaves out failed echoes and, until
 * the latest send is confirmed, the newest echo Flue has not admitted.
 */
export const withoutUnsentEchoes = <Agent extends SentMessagesAgent>(
  agent: Agent,
  unconfirmed: boolean,
): Agent => {
  const failed = new Set(agent.failedSends.map(({ id }) => id));
  const pending = unconfirmed
    ? agent.messages.findLast(
        ({ id, role, submissionId }) =>
          role === "user" && submissionId === undefined && !failed.has(id),
      )
    : undefined;
  if (failed.size === 0 && pending === undefined) return agent;
  return {
    ...agent,
    messages: agent.messages.filter(
      ({ id }) => !failed.has(id) && id !== pending?.id,
    ),
  };
};
