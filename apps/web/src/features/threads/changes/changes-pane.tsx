import { useQuery } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import * as React from "react";
import { defaultChangesTransport } from "./changes-api.js";
import type { ChangesPaneProps } from "./changes-pane-content.js";
import { ChangesPaneContent } from "./changes-pane-loader.js";
import { changesQueryOptions } from "./changes-queries.js";
import "./changes.css";

export const REVIEW_CHANGES_PROMPT =
  "Review all changes since the Thread's initial source commit, including untracked files.";

/**
 * The pane's own loading state while its code loads. It starts the changes
 * request too, so the list and the code arrive together.
 */
function ChangesPaneLoading({
  threadId,
  transport = defaultChangesTransport,
}: Pick<ChangesPaneProps, "threadId" | "transport">) {
  useQuery(changesQueryOptions(transport, threadId, { kind: "all" }));
  return (
    <section className="changes-pane" aria-label="Changes" aria-busy="true">
      <div className="changes-toolbar" data-placeholder="" />
      <div className="changes-scroll" data-empty aria-live="polite">
        <div className="changes-state" role="status">
          <LoaderCircle className="changes-spin" />
          Loading changes…
        </div>
      </div>
    </section>
  );
}

/** The Thread's Changes pane: what its Orb changed, as reviewable diffs. */
export function ChangesPane(props: ChangesPaneProps) {
  return (
    <React.Suspense
      fallback={
        <ChangesPaneLoading
          threadId={props.threadId}
          transport={props.transport}
        />
      }
    >
      <ChangesPaneContent {...props} />
    </React.Suspense>
  );
}
