import type { ThreadId } from "@dx/domain";
import { lazyRouteComponent, useParams } from "@tanstack/react-router";
import { FileText } from "lucide-react";
import * as React from "react";
import { useOpenArtifact } from "../../shared/navigation/open-artifact.js";
import { Button } from "../../shared/ui/button.js";
import { ArtifactDeleteLine } from "./artifact-delete-line.js";
import {
  artifactAction as action,
  artifactOutput as output,
} from "./artifact-tool-part.js";
import type { ToolPart } from "./transcript-activity-projection.js";
import { record, stringField } from "./transcript-activity-summary.js";

/**
 * The agent's `artifact` tool in the transcript. A create or update stands
 * on its own row as a card naming the artifact and its revision; a delete is
 * a card the person confirms, since the agent never deletes on its own.
 * List and read stay in the tool group (artifact-tool-label.tsx). The
 * delete card's controls read the artifacts client, which the Thread page's
 * first load does not need; they load when a delete card shows, behind the
 * same line without buttons.
 */

const ArtifactDeleteControls = lazyRouteComponent(
  () => import("./artifact-delete-controls.js"),
  "ArtifactDeleteControls",
);

/** The delete card: the agent's ask, with controls once they load. */
function ArtifactDeleteConfirm({
  artifactId,
  title,
}: {
  readonly artifactId: string;
  readonly title: string;
}) {
  const params = useParams({ strict: false }) as { threadId?: string };
  const fallback = <ArtifactDeleteLine title={title} state="asked" />;
  if (params.threadId === undefined) return fallback;
  return (
    <React.Suspense fallback={fallback}>
      <ArtifactDeleteControls
        threadId={params.threadId as ThreadId}
        artifactId={artifactId}
        title={title}
      />
    </React.Suspense>
  );
}

/** The card for one create, update, or delete call. */
export function ArtifactToolCard({ part }: { readonly part: ToolPart }) {
  const result = output(part);
  const kind = action(part);
  const title =
    stringField(result, "title") ??
    stringField(part.input, "title") ??
    "artifact";
  const artifactId =
    stringField(result, "artifact_id") ??
    stringField(part.input, "artifact_id");
  const revision = record(result)?.revision;
  const running = part.state === "input-available";
  const failed = part.state === "output-error";
  const attributes = {
    className: "transcript-activity-row transcript-artifact-card",
    "data-tool-category": "artifact",
    "data-artifact-action": kind,
  };

  if (kind === "delete" && result?.pending_confirmation === true && artifactId)
    return (
      <div {...attributes} data-artifact-state="confirm">
        <ArtifactDeleteConfirm artifactId={artifactId} title={title} />
      </div>
    );

  const state = running
    ? "running"
    : failed
      ? "failed"
      : result?.saved === false
        ? "refused"
        : "saved";
  const verb =
    kind === "create"
      ? running
        ? "Creating"
        : failed
          ? "Couldn't create"
          : "Created"
      : kind === "delete"
        ? failed
          ? "Couldn't delete"
          : "Asked to delete"
        : running
          ? "Updating"
          : state === "refused"
            ? "Merging with a newer revision of"
            : failed
              ? "Couldn't update"
              : "Updated";
  return (
    <div {...attributes} data-artifact-state={state}>
      <FileText aria-hidden="true" className="transcript-artifact-icon" />
      <span className="transcript-activity-label">
        {verb} <strong>{title}</strong>
        {typeof revision === "number" && state === "saved" ? (
          <small>Revision {revision}</small>
        ) : null}
      </span>
      {state === "saved" && artifactId !== undefined ? (
        <OpenArtifactButton artifactId={artifactId} title={title} />
      ) : null}
    </div>
  );
}

/** Opens the artifact in the Thread's Artifacts view. */
function OpenArtifactButton({
  artifactId,
  title,
}: {
  readonly artifactId: string;
  readonly title: string;
}) {
  const open = useOpenArtifact();
  return (
    <span className="transcript-artifact-actions">
      <Button
        aria-label={`Open ${title}`}
        onClick={() => open(artifactId)}
        size="xs"
        variant="outline"
      >
        Open
      </Button>
    </span>
  );
}
