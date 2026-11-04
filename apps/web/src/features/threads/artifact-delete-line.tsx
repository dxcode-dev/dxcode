import { Trash2 } from "lucide-react";

/** The delete card's line: what the agent asked, or what became of it. */
export function ArtifactDeleteLine({
  title,
  state,
}: {
  readonly title: string;
  readonly state: "asked" | "deleted" | "kept";
}) {
  return (
    <>
      <Trash2 aria-hidden="true" className="transcript-artifact-icon" />
      <span className="transcript-activity-label">
        {state === "deleted" ? (
          <>
            Deleted <strong>{title}</strong>
          </>
        ) : state === "kept" ? (
          <>
            Kept <strong>{title}</strong>
          </>
        ) : (
          <>
            Delete <strong>{title}</strong>? The agent asked to delete it.
          </>
        )}
      </span>
    </>
  );
}
