import type { UseFlueAgentResult } from "@flue/react";
import { ConfirmDialog } from "../../shared/ui/confirm-dialog.js";
import {
  laterMessageCount,
  type MessageTarget,
  othersRemovedNotice,
  targetRead,
} from "./message-edit-model.js";
import {
  type AgentSource,
  useAgentSelection,
} from "./use-frame-coalesced-agent-session.js";
import "./message-delete-dialog.css";

/**
 * What deleting a message does, as the dialog says it:
 * - `waiting`: the agent has not read it; it leaves the queue.
 * - `read`: the agent read it; the conversation goes back to just before it,
 *   as an edit does, and nothing is sent in its place.
 */
export type MessageDeleteKind =
  | { readonly kind: "waiting" }
  | {
      readonly kind: "read";
      /** Messages after it that go with it, the agent's replies included. */
      readonly later: number;
      /** "Also removes 2 messages from Ada", when others wrote after it. */
      readonly othersRemoved?: string;
      /** The agent is still working on it; deleting stops that turn. */
      readonly working: boolean;
    };

const describe = (target: MessageDeleteKind) => {
  switch (target.kind) {
    case "waiting":
      return "The agent hasn't read it yet and won't see it.";
    case "read":
      return [
        target.later === 0
          ? "The agent forgets this message."
          : target.later === 1
            ? "The agent forgets this message and the one after it."
            : `The agent forgets this message and the ${target.later} after it.`,
        target.working ? "It stops what it's doing." : undefined,
        "Files, artifacts, and costs stay.",
      ]
        .filter((line) => line !== undefined)
        .join(" ");
  }
};

/**
 * Asks before a person deletes one of their messages. `justRead` says the
 * agent read the message while the dialog was open, so what Delete does
 * changed and the person confirms again.
 */
export function MessageDeleteDialog({
  open,
  onOpenChange,
  target,
  justRead = false,
  pending = false,
  error,
  onConfirm,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly target: MessageDeleteKind;
  readonly justRead?: boolean;
  readonly pending?: boolean;
  readonly error?: string;
  readonly onConfirm: () => void;
}) {
  const othersRemoved =
    target.kind === "read" ? target.othersRemoved : undefined;
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Delete message?"
      description={describe(target)}
      confirmLabel="Delete"
      destructive
      pending={pending}
      {...(error === undefined ? {} : { error })}
      onConfirm={onConfirm}
    >
      {justRead || othersRemoved !== undefined ? (
        <div className="message-delete-notes">
          {justRead ? (
            <p className="message-delete-note" data-tone="warning">
              The agent read it while this was open.
            </p>
          ) : null}
          {othersRemoved === undefined ? null : (
            <p className="message-delete-note">{othersRemoved}</p>
          )}
        </div>
      ) : null}
    </ConfirmDialog>
  );
}

/** The message Delete asks about, and what the server said so far. */
export interface DeleteTarget extends MessageTarget {
  /** The server found the agent read it first; `entryId` names it then. */
  readonly readOnServer?: true;
  /**
   * The delete's key, which a retry reuses so it converges on the first
   * outcome. Example: the response to a read delete is lost; Delete again
   * finds the rewind the first one made instead of stopping the agent anew.
   * A changed consequence the person confirms again gets a new key.
   */
  readonly key: string;
}

/**
 * The dialog for one target. It follows the agent picking the message up
 * while it is open: the read variant shows, and says so, before the person
 * confirms again.
 */
export function DeleteConfirm({
  source,
  target,
  viewerId,
  working,
  pending,
  error,
  onCancel,
  onConfirm,
}: {
  readonly source: AgentSource<UseFlueAgentResult>;
  readonly target: DeleteTarget;
  readonly viewerId: string;
  readonly working: boolean;
  readonly pending: boolean;
  readonly error: string | undefined;
  readonly onCancel: () => void;
  readonly onConfirm: (read: boolean) => void;
}) {
  const readHere = useAgentSelection(source, (agent) =>
    targetRead(agent.messages, target),
  );
  const later = useAgentSelection(source, (agent) =>
    laterMessageCount(agent.messages, target),
  );
  const othersRemoved = useAgentSelection(source, (agent) =>
    othersRemovedNotice(agent.messages, target, viewerId),
  );
  const read = readHere || target.readOnServer === true;
  return (
    <MessageDeleteDialog
      open
      onOpenChange={(open) => (open ? undefined : onCancel())}
      target={
        read
          ? {
              kind: "read",
              later,
              working,
              ...(othersRemoved === undefined ? {} : { othersRemoved }),
            }
          : { kind: "waiting" }
      }
      justRead={read && target.startedWaiting}
      pending={pending}
      {...(error === undefined ? {} : { error })}
      onConfirm={() => onConfirm(read)}
    />
  );
}
