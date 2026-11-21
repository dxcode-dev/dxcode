import {
  type MessageAttachment,
  type ThreadQueuedMessage,
  withMessageAttachments,
} from "@dx/api";
import type { UseFlueAgentResult } from "@flue/react";
import * as React from "react";
import { toast } from "sonner";
import { ShortcutKeycaps } from "../../shared/commands/shortcut-keycaps.js";
import { settle } from "../../shared/settle.js";
import { lazyComponent } from "../../shared/stale-chunk.js";
import { Button } from "../../shared/ui/button.js";
import {
  editingNotes,
  type MessageEditing,
  type MessageEditOptions,
  type MessageEditTarget,
  messageTarget,
  othersRemovedNotice,
  targetEntryId,
  targetOriginal,
  targetRead,
  type UserPromptRow,
} from "./message-edit-model.js";
import { editThreadMessageFailure } from "./message-edit-mutations.js";
import {
  messageQueueFailure,
  messageReadBeforeChange,
} from "./message-queue-queries.js";
import type { TranscriptViewModel } from "./transcript-view-model.js";
import {
  type AgentSource,
  useAgentSelection,
} from "./use-frame-coalesced-agent-session.js";
import {
  createPresentationValue,
  type PresentationValue,
} from "./use-thread-presentation.js";

// A sent message's files show only while it is edited, so they load then.
const SentAttachmentPreviews = lazyComponent(() =>
  import("./sent-attachment-previews.js").then((module) => ({
    default: module.SentAttachmentPreviews,
  })),
);

/**
 * The bar above the composer while a person edits a message: what it is,
 * Cancel (Esc), whether the agent read it, and what else the edit removes
 * or keeps. It follows the agent picking the message up.
 */
function ComposerEditingBar({
  source,
  target,
  kept,
  viewerId,
  pending,
  onCancel,
}: {
  readonly source: AgentSource<UseFlueAgentResult>;
  readonly target: MessageEditTarget;
  readonly kept: number;
  readonly viewerId: string;
  readonly pending: boolean;
  readonly onCancel: () => void;
}) {
  const read = useAgentSelection(source, (agent) =>
    targetRead(agent.messages, target),
  );
  const othersRemoved = useAgentSelection(source, (agent) =>
    othersRemovedNotice(agent.messages, target, viewerId),
  );
  return (
    <ComposerEditingBarView
      notes={editingNotes({
        waiting: !read,
        justRead: read && target.startedWaiting,
        othersRemoved,
        attachments: target.attachments.length,
        kept,
      })}
      pending={pending}
      onCancel={onCancel}
    />
  );
}

/**
 * The editing bar as it shows: "Editing message", Cancel (Esc), and one
 * line of notes on what the edit removes or keeps.
 */
export function ComposerEditingBarView({
  notes,
  pending,
  onCancel,
}: {
  readonly notes: ReadonlyArray<string>;
  readonly pending: boolean;
  readonly onCancel: () => void;
}) {
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

type EditOutcome =
  | { readonly kind: "sent" }
  | { readonly kind: "replaced" }
  | { readonly kind: "restarted" }
  | {
      readonly kind: "refused";
      readonly message: string;
      readonly attempt?: MessageEditAttempt;
    }
  | { readonly kind: "not-sent"; readonly message: string };

/**
 * Sends an edit. A message the agent has not read goes to the queue's route,
 * which replaces its text in place. One it read, including one that waited
 * when the person started (the bar then says saving restarts), goes with its
 * exact original text as Flue holds it, and restarts from it. When the
 * agent takes a waiting message just before the queue's route sees it, the
 * route names it (`MESSAGE_READ`) and the edit restarts from it the same
 * way. Either way the new text goes with the files the person kept. `sent`,
 * `replaced`, and `restarted` end editing; `refused` keeps it with the
 * server's reason; `not-sent` means the conversation went back but the new
 * message did not go, so its text moves to the composer.
 */
const submitMessageEdit = async ({
  text,
  target,
  kept,
  agent,
  transcript,
  previous,
  options,
}: {
  readonly text: string;
  readonly target: MessageEditTarget;
  readonly kept: ReadonlyArray<MessageAttachment>;
  readonly agent: UseFlueAgentResult;
  readonly transcript: () => TranscriptViewModel;
  readonly previous: MessageEditAttempt | undefined;
  readonly options: MessageEditOptions;
}): Promise<EditOutcome> => {
  const messages = agent.messages;
  const body = withMessageAttachments(text.trim(), kept);
  const attempt = {
    body,
    key: previous?.body === body ? previous.key : crypto.randomUUID(),
  };
  const { submissionId } = target;
  const { editQueued } = options;
  let readEntryId: string | undefined;
  if (
    target.startedWaiting &&
    submissionId !== undefined &&
    editQueued !== undefined &&
    !targetRead(messages, target)
  ) {
    const sent = await settle(() =>
      editQueued({ submissionId, body, idempotencyKey: attempt.key }),
    );
    if (sent.ok) {
      if (sent.value.outcome === "restarted") return { kind: "restarted" };
      options.updateQueued?.((queued) =>
        replaceQueuedText(queued, submissionId, text.trim(), kept),
      );
      return { kind: "replaced" };
    }
    readEntryId = messageReadBeforeChange(sent.error)?.entryId;
    if (readEntryId === undefined)
      return {
        kind: "refused",
        message: messageQueueFailure(sent.error),
        attempt,
      };
  }
  const original = targetOriginal(messages, target, options.queuedMessages);
  const entryId = readEntryId ?? targetEntryId(transcript(), target, messages);
  if (original === undefined || entryId === undefined)
    return {
      kind: "refused",
      message: "This message is no longer in the conversation.",
    };
  const sent = await settle(() =>
    options.send({ entryId, original, body, idempotencyKey: attempt.key }),
  );
  if (sent.ok)
    return target.startedWaiting ? { kind: "restarted" } : { kind: "sent" };
  const { notSent, message } = editThreadMessageFailure(sent.error);
  return notSent
    ? { kind: "not-sent", message }
    : { kind: "refused", message, attempt };
};

/**
 * The queue as shown after an edit replaced a waiting message's text: its
 * row, or this tab's echo of it, shows the new text until the server's
 * next read. `original` stays as the server tagged it.
 */
const replaceQueuedText = (
  queued: ReadonlyArray<ThreadQueuedMessage>,
  submissionId: string,
  text: string,
  attachments: ReadonlyArray<MessageAttachment>,
): ReadonlyArray<ThreadQueuedMessage> => {
  const replaced = { text, attachments: [...attachments] };
  return queued.some((message) => message.submissionId === submissionId)
    ? queued.map((message) =>
        message.submissionId === submissionId
          ? { ...message, ...replaced }
          : message,
      )
    : [
        ...queued,
        {
          submissionId,
          ...replaced,
          original: withMessageAttachments(text, attachments),
          createdAt: new Date().toISOString(),
        },
      ];
};

/** Why an edit did not go, for the composer's error card; undefined clears it. */
export type MessageEditError =
  | { readonly title: string; readonly message: string }
  | undefined;

/**
 * The composer's editing mode, owned by the agent panel: the message being
 * edited, its own draft (so the person's unsent draft waits untouched), the
 * files it keeps, and sending the edit. The request loads when an edit is
 * sent.
 */
export function useMessageEditing({
  options,
  source,
  draftValue,
  transcript,
  waitingSubmission,
  remove,
  onError,
}: {
  readonly options: MessageEditOptions | undefined;
  readonly source: AgentSource<UseFlueAgentResult>;
  /** The person's own draft, which an edit that was not sent goes back to. */
  readonly draftValue: PresentationValue<string>;
  /** The transcript as shown, read when an edit is sent. */
  readonly transcript: () => TranscriptViewModel;
  /** Rows that wait for the agent, by the submission they wait under. */
  readonly waitingSubmission?: MessageEditing["waitingSubmission"];
  /** Opens Delete for a row; absent where the page does not offer it. */
  readonly remove?: MessageEditing["remove"];
  readonly onError: (error: MessageEditError) => void;
}) {
  const [target, setTarget] = React.useState<MessageEditTarget>();
  const [kept, setKept] = React.useState<ReadonlyArray<MessageAttachment>>([]);
  const [draft] = React.useState(() => createPresentationValue(""));
  const attempt = React.useRef<MessageEditAttempt>(undefined);
  const inFlight = React.useRef(false);
  const focusRef = React.useRef<() => void>(undefined);
  // After a menu closes and gives focus back to its button.
  const focusComposer = () => setTimeout(() => focusRef.current?.(), 0);
  const end = () => {
    setTarget(undefined);
    setKept([]);
    draft.set("");
    attempt.current = undefined;
  };
  const context: MessageEditing | undefined =
    options === undefined
      ? undefined
      : {
          viewerId: options.viewerId,
          ...(target === undefined
            ? {}
            : {
                editingRowId: target.rowId,
                ...(target.submissionId === undefined
                  ? {}
                  : { editingSubmissionId: target.submissionId }),
              }),
          start: (row) => start(row),
          ...(waitingSubmission === undefined ? {} : { waitingSubmission }),
          ...(remove === undefined ? {} : { remove }),
        };
  const start = (row: UserPromptRow) => {
    if (inFlight.current) return;
    const next = messageTarget(row, context);
    if (next.entryId === undefined && next.submissionId === undefined) return;
    attempt.current = undefined;
    draft.set(row.text);
    const attachments = row.attachments ?? [];
    setKept(attachments);
    setTarget({ ...next, attachments });
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
      (text.trim() === "" && kept.length === 0)
    )
      return;
    inFlight.current = true;
    onError(undefined);
    const agent = source.getSnapshot();
    const outcome = await submitMessageEdit({
      text,
      target,
      kept,
      agent,
      transcript,
      previous: attempt.current,
      options,
    });
    inFlight.current = false;
    if (outcome.kind !== "refused" && outcome.kind !== "not-sent") {
      if (target.startedWaiting) options.onQueueChanged?.();
      if (outcome.kind === "restarted")
        toast("The agent read it first, so it restarted from your edit.");
      // Flue reloads the conversation from just before a read message.
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
    context,
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
                kept={kept.length}
                viewerId={options.viewerId}
                pending={options.pending}
                onCancel={cancel}
              />
            ),
            attachments: (
              <React.Suspense fallback={null}>
                <SentAttachmentPreviews
                  attachments={kept}
                  disabled={options.pending}
                  onRemove={(attachment) =>
                    setKept((current) =>
                      current.filter(({ id }) => id !== attachment.id),
                    )
                  }
                />
              </React.Suspense>
            ),
            keptAttachments: kept.length,
            onCancel: cancel,
          },
  };
}
