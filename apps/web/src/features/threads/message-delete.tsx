import type { TranscriptViewModel } from "@dx/client";
import {
  forgetWaitingEcho,
  type MessageEditing,
  targetEntryId,
  targetOriginal,
  type UserPromptRow,
} from "@dx/client";
import type { UseFlueAgentResult } from "@flue/react";
import * as React from "react";
import { settle } from "../../shared/settle.js";
import { lazyComponent } from "../../shared/stale-chunk.js";
import type { DeleteTarget } from "./message-delete-dialog.js";
import type { MessageEditOptions } from "./message-edit-model.js";
import {
  messageQueueFailure,
  messageReadBeforeChange,
} from "./message-queue-queries.js";
import type { AgentSource } from "./use-frame-coalesced-agent-session.js";

// The dialog loads the first time a person deletes a message, so it stays
// out of the Thread page's first load.
const DeleteConfirm = lazyComponent(() =>
  import("./message-delete-dialog.js").then((module) => ({
    default: module.DeleteConfirm,
  })),
);

/** Withdraws a waiting message; reports when the agent took it first. */
const withdraw = async (
  submissionId: string,
  key: string,
  remove: NonNullable<MessageEditOptions["remove"]>,
) => {
  const removed = await settle(() =>
    remove({ kind: "queued", submissionId, idempotencyKey: key }),
  );
  if (removed.ok) return { kind: "withdrawn" as const };
  const taken = messageReadBeforeChange(removed.error);
  return taken === undefined
    ? {
        kind: "refused" as const,
        message: messageQueueFailure(removed.error),
      }
    : { kind: "read" as const, entryId: taken.entryId };
};

/**
 * Deleting the viewer's messages, owned by the agent panel. A message the
 * agent has not read leaves the queue; one it read takes the conversation
 * back to just before it. When the agent took a waiting message first, the
 * dialog stays open and asks again, never deleting more than the person saw.
 */
export function useMessageDeleting({
  options,
  source,
  transcript,
  waitingSubmission,
  working,
}: {
  readonly options: MessageEditOptions | undefined;
  readonly source: AgentSource<UseFlueAgentResult>;
  readonly transcript: () => TranscriptViewModel;
  readonly waitingSubmission?: MessageEditing["waitingSubmission"];
  /** The agent is working, so deleting a read message stops it. */
  readonly working: boolean;
}) {
  const [target, setTarget] = React.useState<DeleteTarget>();
  const [error, setError] = React.useState<string>();
  const [pending, setPending] = React.useState(false);
  const remove = options?.remove;
  const close = () => {
    setTarget(undefined);
    setError(undefined);
  };
  const start = (row: UserPromptRow) => {
    const waiting = waitingSubmission?.(row);
    const submissionId = waiting ?? row.submissionId;
    const entryId =
      waiting === undefined ? (row.flueMessageId ?? row.messageId) : undefined;
    setError(undefined);
    setTarget({
      rowId: row.id,
      messageId: row.messageId,
      ...(entryId?.startsWith("entry_") ? { entryId } : {}),
      ...(submissionId === undefined ? {} : { submissionId }),
      startedWaiting: waiting !== undefined,
      key: crypto.randomUUID(),
    });
  };
  const withdrawn = (submissionId: string) => {
    // Off the queue as shown first, or its row would show again from it.
    options?.updateQueued?.((queued) =>
      queued.filter((message) => message.submissionId !== submissionId),
    );
    forgetWaitingEcho(source.getSnapshot(), submissionId);
    options?.onQueueChanged?.();
    close();
  };
  const deleteTarget = async (
    target: DeleteTarget,
    read: boolean,
    remove: NonNullable<MessageEditOptions["remove"]>,
  ) => {
    const { submissionId } = target;
    if (!read && submissionId !== undefined) {
      const outcome = await withdraw(submissionId, target.key, remove);
      if (outcome.kind === "withdrawn") withdrawn(submissionId);
      else if (outcome.kind === "read") {
        // The agent read it first: ask again with what deleting does now.
        setTarget({
          ...target,
          readOnServer: true,
          key: crypto.randomUUID(),
          ...(outcome.entryId === undefined
            ? {}
            : { entryId: outcome.entryId }),
        });
        options?.onQueueChanged?.();
      } else setError(outcome.message);
      return;
    }
    const messages = source.getSnapshot().messages;
    const original = targetOriginal(messages, target, options?.queuedMessages);
    let entryId = targetEntryId(transcript(), target, messages);
    // A message read since it waited: the queue's route names it.
    if (entryId === undefined && submissionId !== undefined) {
      const outcome = await withdraw(submissionId, target.key, remove);
      if (outcome.kind === "withdrawn") {
        withdrawn(submissionId);
        return;
      }
      if (outcome.kind === "read") entryId = outcome.entryId;
    }
    if (original === undefined || entryId === undefined) {
      setError("This message is no longer in the conversation.");
      return;
    }
    const removed = await settle(() =>
      remove({
        kind: "read",
        entryId,
        original,
        idempotencyKey: target.key,
      }),
    );
    if (removed.ok) close();
    else setError(messageQueueFailure(removed.error));
  };
  const confirm = (read: boolean) => {
    if (target === undefined || remove === undefined || pending)
      return Promise.resolve();
    setPending(true);
    setError(undefined);
    return deleteTarget(target, read, remove).finally(() => setPending(false));
  };
  return {
    /** Opens Delete for a row; absent where the page does not offer it. */
    start: remove === undefined ? undefined : start,
    dialog:
      target === undefined || options === undefined ? null : (
        <React.Suspense fallback={null}>
          <DeleteConfirm
            source={source}
            target={target}
            viewerId={options.viewerId}
            working={working}
            pending={pending}
            error={error}
            onCancel={() => {
              if (!pending) close();
            }}
            onConfirm={(read) => void confirm(read)}
          />
        </React.Suspense>
      ),
  };
}
