import { ChevronDown, ChevronUp, X } from "lucide-react";
import * as React from "react";
import type {
  ArtifactSession,
  ArtifactSessionSnapshot,
} from "./artifact-session.js";

/**
 * Find in the artifact (#1810), under its toolbar: the query, "2 of 5",
 * Previous and Next Match, and Close. Enter moves to the next match,
 * Shift+Enter to the previous; Escape closes. The parent keys it per
 * opening, so Ctrl+F on an open bar selects the query again.
 */
export function FindBar({
  session,
  find,
  onClose,
}: {
  readonly session: ArtifactSession;
  readonly find: NonNullable<ArtifactSessionSnapshot["find"]>;
  readonly onClose: () => void;
}) {
  const count =
    find.query === ""
      ? ""
      : find.count === 0
        ? "No results"
        : `${find.current + 1} of ${find.count}`;
  return (
    <search className="artifact-find" aria-label="Find">
      <input
        ref={(node) => {
          node?.focus();
          node?.select();
        }}
        aria-label="Find in artifact"
        placeholder="Find in artifact"
        value={find.query}
        onChange={(event) => session.find(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            session.findStep(event.shiftKey ? -1 : 1);
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
      />
      <span className="artifact-find-count" aria-live="polite">
        {count}
      </span>
      <button
        type="button"
        className="artifact-icon-button"
        aria-label="Previous Match"
        title="Previous match (Shift+Enter)"
        disabled={find.count === 0}
        onClick={() => session.findStep(-1)}
      >
        <ChevronUp aria-hidden="true" />
      </button>
      <button
        type="button"
        className="artifact-icon-button"
        aria-label="Next Match"
        title="Next match (Enter)"
        disabled={find.count === 0}
        onClick={() => session.findStep(1)}
      >
        <ChevronDown aria-hidden="true" />
      </button>
      <button
        type="button"
        className="artifact-icon-button"
        aria-label="Close Find"
        title="Close (Escape)"
        onClick={onClose}
      >
        <X aria-hidden="true" />
      </button>
    </search>
  );
}

/**
 * Opens Find (Ctrl+F or the header's button): with the selection's text
 * when it is on one line, as browsers do. Each opening counts, to key the
 * bar, so Ctrl+F on an open bar selects its query again.
 */
export function useFindOpener(
  session: ArtifactSession,
  snapshot: ArtifactSessionSnapshot,
) {
  const [openings, setOpenings] = React.useState(0);
  const open = () => {
    if (snapshot.find === undefined) {
      const { from, to } = session.state.selection;
      const selected = session.state.doc.textBetween(from, to, "\n");
      session.find(selected.includes("\n") ? "" : selected);
    }
    setOpenings((count) => count + 1);
  };
  return { openings, open };
}
