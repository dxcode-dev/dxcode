import { lazyRouteComponent } from "@tanstack/react-router";
import * as React from "react";

/** One edit: a file's replaced region, before and after. */
export interface EditDiffSource {
  readonly path: string;
  readonly before: string;
  readonly after: string;
}

// The diff renderer loads when the first edit diff renders, not with the
// page. `lazyRouteComponent` reloads the page once if a deploy removed the
// chunk.
const Content = lazyRouteComponent(
  () => import("./edit-diff-content.js"),
  "EditDiffContent",
);

/** An edit as a highlighted unified diff; plain text while it loads. */
export function EditDiff(props: { readonly source: EditDiffSource }) {
  return (
    <React.Suspense
      fallback={
        <pre className="transcript-edit-output">{props.source.after}</pre>
      }
    >
      <Content {...props} />
    </React.Suspense>
  );
}
