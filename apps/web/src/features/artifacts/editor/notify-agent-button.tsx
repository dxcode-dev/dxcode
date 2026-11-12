import type { ThreadId } from "@dx/domain";
import { useMutation } from "@tanstack/react-query";
import { Check, Send } from "lucide-react";
import { notifyArtifactAgentMutation } from "../artifact-document-queries.js";

/**
 * Notify agent (#1765): edits don't wake the agent, so this wakes it once
 * with what changed since it last saved the artifact. It reads "Notified" in its
 * own color for the revision it told the agent about, and offers to notify
 * again once someone saves a newer one.
 */
export function NotifyAgentButton({
  threadId,
  artifactId,
  revision,
}: {
  readonly threadId: ThreadId;
  readonly artifactId: string;
  /** The revision the editor's content is based on. */
  readonly revision: number;
}) {
  const notify = useMutation(notifyArtifactAgentMutation(threadId, artifactId));
  const sent = notify.isSuccess && notify.data.revision >= revision;
  const failed = notify.isError;
  return (
    <button
      type="button"
      className="artifact-tool artifact-notify-agent"
      data-sent={sent || undefined}
      data-failed={failed || undefined}
      disabled={notify.isPending}
      title={
        failed
          ? "Couldn't notify the agent. Try again."
          : sent
            ? "The agent was notified of this revision. Notify again after more edits."
            : "Wake the agent once with what changed since it last saved this artifact. Edits alone no longer wake it."
      }
      onClick={() => notify.mutate()}
    >
      {sent ? <Check aria-hidden="true" /> : <Send aria-hidden="true" />}
      <span>
        {notify.isPending
          ? "Notifying…"
          : sent
            ? "Notified"
            : failed
              ? "Retry notify"
              : "Notify agent"}
      </span>
    </button>
  );
}
