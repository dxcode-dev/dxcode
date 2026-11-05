import { ARTIFACT_NOTIFY_AGENT_FEATURE } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, Send } from "lucide-react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { personalExperimentalFeaturesQueryOptions } from "../../settings/experimental-features/experimental-features-queries.js";
import { notifyArtifactAgentMutation } from "../artifact-document-queries.js";

/**
 * Notify agent (#1765), behind the person's `artifact-notify-agent` flag:
 * with it on, edits no longer wake the agent, and this wakes it once with
 * what changed since it last saved the artifact. It reads "Notified" in its
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
  const { identity } = useAuthenticatedIdentity();
  const features = useQuery(
    personalExperimentalFeaturesQueryOptions(identity.id),
  );
  const notify = useMutation(notifyArtifactAgentMutation(threadId, artifactId));
  const enabled =
    features.data?.flags.some(
      ({ registration, effectiveEnabled }) =>
        registration.id === ARTIFACT_NOTIFY_AGENT_FEATURE && effectiveEnabled,
    ) === true;
  if (!enabled) return null;
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
