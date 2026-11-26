// What the message menu, the editing bar, and the delete dialog know about a
// message: whether it can be changed, whether the agent read it, and what an
// edit or a delete removes.
import {
  type MessageAttachment,
  parseMessageAuthor,
  type ThreadQueuedMessage,
} from "@dx/api";
import type { FlueConversationMessage } from "@flue/sdk";
import type {
  TranscriptRow,
  TranscriptRowId,
  TranscriptViewModel,
} from "./transcript-view-model.js";

export type UserPromptRow = Extract<
  TranscriptRow,
  { readonly kind: "user-prompt" }
>;

/**
 * The message a person is editing or deleting. A message the agent has not
 * read is named by its submission, which stays the same as its row changes
 * from this tab's echo, or from a waiting row, to Flue's record of it.
 */
export interface MessageTarget {
  readonly rowId: TranscriptRowId;
  /** The message's id in the Flue session the transcript shows. */
  readonly messageId: string;
  /** Flue's id in its history (`entry_…`), once the agent read it. */
  readonly entryId?: string;
  /** The Flue submission it came in; known for a waiting message. */
  readonly submissionId?: string;
  /** It waited for the agent when the person started. */
  readonly startedWaiting: boolean;
}

/** The message a person is editing, as the composer's editing bar holds it. */
export interface MessageEditTarget extends MessageTarget {
  /** Files the message sent; the edit sends the ones the person keeps. */
  readonly attachments: ReadonlyArray<MessageAttachment>;
}

/**
 * What the transcript needs to offer Edit and Delete: who is reading, the
 * message being edited (highlighted; when the agent read it, everything
 * after it dims), and how to start. Absent where nobody may edit: Spaces,
 * archived Threads, and viewers.
 */
export interface MessageEditing {
  readonly viewerId: string;
  readonly editingRowId?: TranscriptRowId;
  /** The edited message's submission, which outlives its row's id. */
  readonly editingSubmissionId?: string;
  readonly start: (row: UserPromptRow) => void;
  /**
   * The submission of the viewer's own message that waits for the agent to
   * read it, which they may edit or delete in place; undefined once read.
   * Absent where the page does not offer it.
   */
  readonly waitingSubmission?: (row: UserPromptRow) => string | undefined;
  /** Asks to delete one of the viewer's messages. Absent where not offered. */
  readonly remove?: (row: UserPromptRow) => void;
}

/** The submission a row waits under, when it waits for the agent. */
export const rowWaitingSubmission = (
  row: TranscriptRow,
  editing: MessageEditing | undefined,
) =>
  row.kind === "user-prompt" ? editing?.waitingSubmission?.(row) : undefined;

/** The row is the message being edited, under any of its ids. */
export const isEditedRow = (
  row: TranscriptRow,
  editing: MessageEditing | undefined,
) =>
  editing !== undefined &&
  (row.id === editing.editingRowId ||
    (editing.editingSubmissionId !== undefined &&
      row.kind === "user-prompt" &&
      (row.submissionId === editing.editingSubmissionId ||
        rowWaitingSubmission(row, editing) === editing.editingSubmissionId)));

/**
 * Flue's history id of a prompt (`entry_…`); one sent from this page has a
 * local id. The edit route checks the full form (`THREAD_MESSAGE_ENTRY_ID`),
 * whose module stays out of the Thread page's first load.
 */
export const messageEntryId = (row: UserPromptRow) => {
  const id = row.flueMessageId ?? row.messageId;
  return id.startsWith("entry_") ? id : undefined;
};

/**
 * A message the viewer typed themselves, which Flue holds or which waits for
 * the agent to read it: not a chat between members, nor one an automation,
 * another Thread, or a comment sent.
 */
export const canEditMessage = (
  row: TranscriptRow,
  editing: MessageEditing | undefined,
): row is UserPromptRow =>
  editing !== undefined &&
  row.kind === "user-prompt" &&
  row.chat !== true &&
  row.automation === undefined &&
  row.sourceThreadId === undefined &&
  row.commentOn === undefined &&
  row.plugin === undefined &&
  ((row.admitted &&
    row.author?.userId === editing.viewerId &&
    messageEntryId(row) !== undefined) ||
    editing.waitingSubmission?.(row) !== undefined);

/** A message the viewer may edit, where the page offers Delete too. */
export const canDeleteMessage = (
  row: TranscriptRow,
  editing: MessageEditing | undefined,
): row is UserPromptRow =>
  editing?.remove !== undefined && canEditMessage(row, editing);

/** Where to start editing or deleting a row from. */
export const messageTarget = (
  row: UserPromptRow,
  editing: MessageEditing | undefined,
): MessageTarget => {
  const waiting = editing?.waitingSubmission?.(row);
  const submissionId = waiting ?? row.submissionId;
  const entryId = waiting === undefined ? messageEntryId(row) : undefined;
  return {
    rowId: row.id,
    messageId: row.messageId,
    ...(entryId === undefined ? {} : { entryId }),
    ...(submissionId === undefined ? {} : { submissionId }),
    startedWaiting: waiting !== undefined,
  };
};

/** A user message's first text part, as Flue holds it. */
export const messageOriginal = (message: FlueConversationMessage | undefined) =>
  message?.parts.find((part) => part.type === "text")?.text;

/**
 * The target's exact text as Flue holds it: its record in the conversation,
 * or, when the agent just read it and the record has not arrived, the
 * server's queue's copy, which Flue's record repeats.
 */
export const targetOriginal = (
  messages: ReadonlyArray<FlueConversationMessage>,
  target: MessageTarget,
  queued: ReadonlyArray<ThreadQueuedMessage> | undefined,
) =>
  messageOriginal(messages[findTargetMessage(messages, target)]) ??
  (target.submissionId === undefined
    ? undefined
    : queued?.find(({ submissionId }) => submissionId === target.submissionId)
        ?.original);

/**
 * The target in the conversation: Flue's record of its submission, under
 * the session's id, or under Flue's once its history was read again.
 */
export const findTargetMessage = (
  messages: ReadonlyArray<FlueConversationMessage>,
  target: MessageTarget,
) =>
  messages.findIndex(
    ({ id, role, submissionId }) =>
      (role === "user" &&
        target.submissionId !== undefined &&
        submissionId === target.submissionId) ||
      (target.submissionId === undefined &&
        (id === target.messageId || id === target.entryId)),
  );

/**
 * The agent read the message: Flue holds it. A message that waited until
 * now is read once Flue's record of its submission arrives.
 */
export const targetRead = (
  messages: ReadonlyArray<FlueConversationMessage>,
  target: MessageTarget,
) =>
  !target.startedWaiting ||
  messages.some(
    ({ role, submissionId }) =>
      role === "user" && submissionId === target.submissionId,
  );

/** Flue's history id of a read target, from the transcript as shown. */
export const targetEntryId = (
  model: TranscriptViewModel,
  target: MessageTarget,
  messages: ReadonlyArray<FlueConversationMessage>,
) => {
  if (target.entryId !== undefined) return target.entryId;
  const row = model.rows.find(
    (candidate): candidate is UserPromptRow =>
      candidate.kind === "user-prompt" &&
      target.submissionId !== undefined &&
      candidate.submissionId === target.submissionId,
  );
  const fromRow = row === undefined ? undefined : messageEntryId(row);
  if (fromRow !== undefined) return fromRow;
  const id = messages[findTargetMessage(messages, target)]?.id;
  return id?.startsWith("entry_") ? id : undefined;
};

/** How many messages after the target go with it, the agent's included. */
export const laterMessageCount = (
  messages: ReadonlyArray<FlueConversationMessage>,
  target: MessageTarget,
) => {
  const start = findTargetMessage(messages, target);
  if (start === -1) return 0;
  return messages
    .slice(start + 1)
    .filter(
      ({ role, display }) =>
        (role === "user" || role === "assistant") && display !== "hidden",
    ).length;
};

/**
 * Who else wrote after the target, which an edit or delete also removes:
 * "Also removes 2 messages from Ada". Undefined when only the viewer and
 * the agent did.
 */
export const othersRemovedNotice = (
  messages: ReadonlyArray<FlueConversationMessage>,
  target: MessageTarget,
  viewerId: string,
) => {
  const start = findTargetMessage(messages, target);
  if (start === -1) return undefined;
  const names = new Map<string, { name: string; count: number }>();
  let total = 0;
  for (const message of messages.slice(start + 1)) {
    if (message.role !== "user") continue;
    const author = parseMessageAuthor(messageOriginal(message) ?? "").author;
    // A message without a tag is this page's own unconfirmed send.
    if (author === undefined || author.userId === viewerId) continue;
    total += 1;
    const entry = names.get(author.userId);
    if (entry === undefined)
      names.set(author.userId, { name: author.name, count: 1 });
    else entry.count += 1;
  }
  if (total === 0) return undefined;
  const people = [...names.values()]
    .sort((left, right) => right.count - left.count)
    .map(({ name }) => name);
  const from =
    people.length === 1
      ? people[0]
      : people.length === 2
        ? `${people[0]} and ${people[1]}`
        : `${people[0]} and ${people.length - 1} others`;
  return `Also removes ${total} ${total === 1 ? "message" : "messages"} from ${from}`;
};

/**
 * Takes this tab's echo of a withdrawn message out of Flue's session, which
 * would otherwise keep it waiting for a record that never comes.
 */
export const forgetWaitingEcho = (
  agent: {
    readonly localSubmissions?: ReadonlyArray<{
      readonly localId: string;
      readonly submissionId: string;
    }>;
    readonly forgetSend?: (localId: string) => void;
  },
  submissionId: string | undefined,
) => {
  if (submissionId === undefined) return;
  const local = agent.localSubmissions?.find(
    (entry) => entry.submissionId === submissionId,
  );
  if (local !== undefined) agent.forgetSend?.(local.localId);
};

/** What the edit does with the message's files: keeps, or removes some. */
const attachmentNote = (total: number, kept: number) => {
  if (total === 0) return undefined;
  if (kept === total)
    return `Keeps ${kept === 1 ? "its attachment" : `its ${kept} attachments`}`;
  const removed = total - kept;
  return kept === 0
    ? `Removes ${removed === 1 ? "its attachment" : `its ${removed} attachments`}`
    : `Keeps ${kept} of its ${total} attachments`;
};

/** The editing bar's notes: whether the agent read it, and what goes. */
export const editingNotes = ({
  waiting,
  justRead,
  othersRemoved,
  attachments,
  kept,
}: {
  readonly waiting: boolean;
  readonly justRead: boolean;
  readonly othersRemoved: string | undefined;
  readonly attachments: number;
  readonly kept: number;
}) =>
  [
    waiting
      ? "The agent hasn't read it yet, so saving replaces it."
      : justRead
        ? "The agent just read it. Saving restarts from this message."
        : undefined,
    waiting ? undefined : othersRemoved,
    attachmentNote(attachments, kept),
  ].filter((note) => note !== undefined);
