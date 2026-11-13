import {
  type MessageAttachment,
  parseMessageAuthor,
  withMessageAttachments,
} from "@dx/api";
import type { FlueConversationMessage, UseFlueAgentResult } from "@flue/react";
import * as React from "react";
import { ShortcutKeycaps } from "../../shared/commands/shortcut-keycaps.js";
import { settle } from "../../shared/settle.js";
import { Button } from "../../shared/ui/button.js";
import {
  type EditThreadMessageInput,
  editThreadMessageFailure,
} from "./message-edit-mutations.js";
import type {
  TranscriptRow,
  TranscriptRowId,
} from "./transcript-view-model.js";
import {
  type AgentSource,
  useAgentSelection,
} from "./use-frame-coalesced-agent-session.js";
import {
  createPresentationValue,
  type PresentationValue,
} from "./use-thread-presentation.js";

export type UserPromptRow = Extract<
  TranscriptRow,
  { readonly kind: "user-prompt" }
>;

/** The message a person is editing, as the composer's editing bar holds it. */
export interface MessageEditTarget {
  readonly rowId: TranscriptRowId;
  /** The message's id in the Flue session the transcript shows. */
  readonly messageId: string;
  /** Flue's id in its history (`entry_…`), which the edit route names. */
  readonly entryId: string;
  /** Files the message sent; the edit sends them again. */
  readonly attachments: ReadonlyArray<MessageAttachment>;
}

/**
 * Editing earlier messages, which the Thread page offers in ordinary Threads
 * the viewer can write to: never in a Space, an archived Thread, or to a
 * viewer. `send` is the edit mutation; `pending` its state.
 */
export interface MessageEditOptions {
  readonly viewerId: string;
  readonly send: (input: EditThreadMessageInput) => Promise<unknown>;
  readonly pending: boolean;
}

/**
 * What the transcript needs to offer Edit: who is reading, the row being
 * edited (highlighted, with everything after it dimmed), and how to start.
 * Absent where nobody may edit: Spaces, archived Threads, and viewers.
 */
export interface MessageEditing {
  readonly viewerId: string;
  readonly editingRowId?: TranscriptRowId;
  readonly start: (row: UserPromptRow) => void;
}

export const MessageEditContext = React.createContext<
  MessageEditing | undefined
>(undefined);

/**
 * Flue's history id of a prompt (`entry_…`); one sent from this page has a
 * local id. The edit route checks the full form (`THREAD_MESSAGE_ENTRY_ID`),
 * whose module stays out of the Thread page's first load.
 */
const messageEntryId = (row: UserPromptRow) => {
  const id = row.flueMessageId ?? row.messageId;
  return id.startsWith("entry_") ? id : undefined;
};

/**
 * A message the viewer typed themselves and Flue holds: not a chat between
 * members, nor one an automation, another Thread, or a comment sent.
 */
export const canEditMessage = (
  row: TranscriptRow,
  editing: MessageEditing | undefined,
): row is UserPromptRow =>
  editing !== undefined &&
  row.kind === "user-prompt" &&
  row.admitted &&
  row.author?.userId === editing.viewerId &&
  row.chat !== true &&
  row.automation === undefined &&
  row.sourceThreadId === undefined &&
  row.commentOn === undefined &&
  row.plugin === undefined &&
  messageEntryId(row) !== undefined;

/** A user message's first text part, as Flue holds it. */
const messageOriginal = (message: FlueConversationMessage | undefined) =>
  message?.parts.find((part) => part.type === "text")?.text;

/**
 * The edited message in the conversation: under the session's id, or under
 * Flue's once its history was read again.
 */
const findEditedMessage = (
  messages: ReadonlyArray<FlueConversationMessage>,
  target: MessageEditTarget,
) =>
  messages.findIndex(
    ({ id }) => id === target.messageId || id === target.entryId,
  );

/**
 * Who else wrote after the edited message, which the edit also removes:
 * "Also removes 2 messages from Ada". Undefined when only the viewer and
 * the agent did.
 */
const othersRemovedNotice = (
  messages: ReadonlyArray<FlueConversationMessage>,
  target: MessageEditTarget,
  viewerId: string,
) => {
  const start = findEditedMessage(messages, target);
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
 * The bar above the composer while a person edits an earlier message: what
 * it is, Cancel (Esc), and what else the edit removes or keeps.
 */
function ComposerEditingBar({
  source,
  target,
  viewerId,
  pending,
  onCancel,
}: {
  readonly source: AgentSource<UseFlueAgentResult>;
  readonly target: MessageEditTarget;
  readonly viewerId: string;
  readonly pending: boolean;
  readonly onCancel: () => void;
}) {
  const othersRemoved = useAgentSelection(source, (agent) =>
    othersRemovedNotice(agent.messages, target, viewerId),
  );
  const files = target.attachments.length;
  const notes = [
    othersRemoved,
    files === 0
      ? undefined
      : `Keeps ${files === 1 ? "its attachment" : `its ${files} attachments`}`,
  ].filter((note) => note !== undefined);
  return (
    <div
      className="composer-editing-bar"
      data-pending={pending ? "" : undefined}
    >
      <div className="composer-editing-row">
        <span className="composer-editing-title">Editing message</span>
        <Button
          type="button"
          variant="subtle"
          size="xs"
          className="composer-editing-cancel"
          disabled={pending}
          onClick={onCancel}
        >
          Cancel
          <span className="composer-editing-key">
            <ShortcutKeycaps keycaps={["Esc"]} />
          </span>
        </Button>
      </div>
      {notes.length === 0 ? null : (
        <p className="composer-editing-note">{notes.join(" · ")}</p>
      )}
    </div>
  );
}

/** The last attempt, whose key a retry of the same message reuses. */
interface MessageEditAttempt {
  readonly body: string;
  readonly key: string;
}

/**
 * Sends an edit: the message's exact original text as Flue holds it, and
 * the new text with the message's files. `sent` ends editing; `refused`
 * keeps it with the server's reason; `not-sent` means the conversation went
 * back but the new message did not go, so its text moves to the composer.
 */
const submitMessageEdit = async ({
  text,
  target,
  messages,
  previous,
  send,
}: {
  readonly text: string;
  readonly target: MessageEditTarget;
  readonly messages: ReadonlyArray<FlueConversationMessage>;
  readonly previous: MessageEditAttempt | undefined;
  readonly send: MessageEditOptions["send"];
}): Promise<
  | { readonly kind: "sent" }
  | {
      readonly kind: "refused";
      readonly message: string;
      readonly attempt?: MessageEditAttempt;
    }
  | { readonly kind: "not-sent"; readonly message: string }
> => {
  const original = messageOriginal(
    messages[findEditedMessage(messages, target)],
  );
  if (original === undefined)
    return {
      kind: "refused",
      message: "This message is no longer in the conversation.",
    };
  const body = withMessageAttachments(text.trim(), target.attachments);
  const attempt = {
    body,
    key: previous?.body === body ? previous.key : crypto.randomUUID(),
  };
  const sent = await settle(() =>
    send({
      entryId: target.entryId,
      original,
      body,
      idempotencyKey: attempt.key,
    }),
  );
  if (sent.ok) return { kind: "sent" };
  const { notSent, message } = editThreadMessageFailure(sent.error);
  return notSent
    ? { kind: "not-sent", message }
    : { kind: "refused", message, attempt };
};

/** Why an edit did not go, for the composer's error card; undefined clears it. */
export type MessageEditError =
  | { readonly title: string; readonly message: string }
  | undefined;

/**
 * The composer's editing mode, owned by the agent panel: the message being
 * edited, its own draft (so the person's unsent draft waits untouched), and
 * sending the edit. The request loads when an edit is sent.
 */
export function useMessageEditing({
  options,
  source,
  draftValue,
  onError,
}: {
  readonly options: MessageEditOptions | undefined;
  readonly source: AgentSource<UseFlueAgentResult>;
  /** The person's own draft, which an edit that was not sent goes back to. */
  readonly draftValue: PresentationValue<string>;
  readonly onError: (error: MessageEditError) => void;
}) {
  const [target, setTarget] = React.useState<MessageEditTarget>();
  const [draft] = React.useState(() => createPresentationValue(""));
  const attempt = React.useRef<MessageEditAttempt>(undefined);
  const inFlight = React.useRef(false);
  const focusRef = React.useRef<() => void>(undefined);
  // After a menu closes and gives focus back to its button.
  const focusComposer = () => setTimeout(() => focusRef.current?.(), 0);
  const end = () => {
    setTarget(undefined);
    draft.set("");
    attempt.current = undefined;
  };
  const start = (row: UserPromptRow) => {
    const entryId = messageEntryId(row);
    if (entryId === undefined || inFlight.current) return;
    attempt.current = undefined;
    draft.set(row.text);
    setTarget({
      rowId: row.id,
      messageId: row.messageId,
      entryId,
      attachments: row.attachments ?? [],
    });
    onError(undefined);
    focusComposer();
  };
  const cancel = () => {
    if (inFlight.current) return;
    end();
    onError(undefined);
    focusComposer();
  };
  const submit = async (text: string) => {
    if (
      target === undefined ||
      options === undefined ||
      inFlight.current ||
      text.trim() === ""
    )
      return;
    inFlight.current = true;
    onError(undefined);
    const outcome = await submitMessageEdit({
      text,
      target,
      messages: source.getSnapshot().messages,
      previous: attempt.current,
      send: options.send,
    });
    inFlight.current = false;
    if (outcome.kind === "sent") {
      // Flue reloads the conversation from just before the message.
      end();
      return;
    }
    if (outcome.kind === "not-sent") {
      // The conversation went back, but the message was not sent: it moves
      // to the composer to send as a new message.
      const current = draftValue.get();
      draftValue.set(current.trim() === "" ? text : `${text}\n\n${current}`);
      end();
      onError({ title: "Edited message not sent", message: outcome.message });
      return;
    }
    attempt.current = outcome.attempt;
    onError({ title: "Message not edited", message: outcome.message });
  };
  const editing = target !== undefined && options !== undefined;
  return {
    /** For the transcript; absent where the viewer may not edit. */
    context:
      options === undefined
        ? undefined
        : { viewerId: options.viewerId, editingRowId: target?.rowId, start },
    editing,
    /** The composer's draft while editing. */
    draft,
    focusRef,
    submit,
    composer:
      target === undefined || options === undefined
        ? undefined
        : {
            bar: (
              <ComposerEditingBar
                source={source}
                target={target}
                viewerId={options.viewerId}
                pending={options.pending}
                onCancel={cancel}
              />
            ),
            onCancel: cancel,
          },
  };
}
