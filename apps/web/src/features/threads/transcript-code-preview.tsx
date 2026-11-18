import { lazyRouteComponent } from "@tanstack/react-router";
import * as React from "react";
import { EditDiff } from "../../shared/ui/edit-diff.js";
import type { TranscriptEditSource } from "./transcript-code-preview-model.js";

// The code viewer loads when a tool call's output is first
// expanded, not with the transcript. `lazyRouteComponent` reloads the page
// once if a deploy removed the chunk.
const CodePreview = lazyRouteComponent(
  () => import("./transcript-code-preview-content.js"),
  "TranscriptCodePreview",
);

/** A tool call's file or patch, highlighted; plain text while it loads. */
export function TranscriptCodePreview(props: {
  readonly path: string;
  readonly contents: string;
  readonly kind: "file" | "patch";
}) {
  return (
    <React.Suspense
      fallback={<pre className="transcript-edit-output">{props.contents}</pre>}
    >
      <CodePreview {...props} />
    </React.Suspense>
  );
}

/** An edit tool call as a diff of the replaced region. */
export function TranscriptEditDiff(props: {
  readonly source: TranscriptEditSource;
}) {
  return <EditDiff {...props} />;
}
