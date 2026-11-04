import type { ThreadId } from "@dx/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { Button } from "../../shared/ui/button.js";
import { ArtifactDeleteLine } from "./artifact-delete-line.js";
import {
  artifactListQueryOptions,
  deleteArtifactMutationOptions,
  isMissingArtifact,
} from "./artifact-tool-queries.js";

/**
 * The agent's delete, confirmed by the person, decided from the Thread's
 * artifact list: Delete and Keep show only while the list says the artifact
 * is still there, and "Deleted" once it is not. The list keeps its data while
 * it refetches (on focus, or after another artifact changes), so the card
 * never flashes buttons for an artifact already gone. Until the list first
 * loads, the card says what the agent asked, without buttons.
 */
export function ArtifactDeleteControls({
  threadId,
  artifactId,
  title,
}: {
  readonly threadId: ThreadId;
  readonly artifactId: string;
  readonly title: string;
}) {
  const queryClient = useQueryClient();
  const [kept, setKept] = React.useState(false);
  const list = useQuery(artifactListQueryOptions(threadId));
  const deletion = useMutation(
    deleteArtifactMutationOptions(queryClient, threadId, artifactId),
  );
  const listed = list.data?.some(({ id }) => id === artifactId);
  const gone =
    deletion.isSuccess ||
    isMissingArtifact(deletion.error) ||
    (list.data !== undefined && listed === false);
  return (
    <>
      <ArtifactDeleteLine
        title={title}
        state={gone ? "deleted" : kept ? "kept" : "asked"}
      />
      {gone || kept || listed !== true ? null : (
        <span className="transcript-artifact-actions">
          <Button
            disabled={deletion.isPending}
            onClick={() => deletion.mutate()}
            size="xs"
            variant="destructive"
          >
            {deletion.isPending ? "Deleting…" : "Delete"}
          </Button>
          <Button
            disabled={deletion.isPending}
            onClick={() => setKept(true)}
            size="xs"
            variant="outline"
          >
            Keep
          </Button>
        </span>
      )}
      {deletion.isError && !gone ? (
        <small className="transcript-artifact-error" role="alert">
          Couldn't delete. Try again.
        </small>
      ) : null}
    </>
  );
}
