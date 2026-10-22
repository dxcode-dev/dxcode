import * as React from "react";

export interface MarkdownViewProps {
  readonly source: string;
  readonly actions: React.ReactNode;
  /** Shown instead of the view when its chunk cannot load. */
  readonly fallback: React.ReactNode;
}

/**
 * The view code and kit are one chunk that loads with the first view, as
 * Mermaid and KaTeX load with the first diagram or formula. A chunk that
 * cannot load leaves each view as its source.
 */
const ViewFrame = React.lazy<React.ComponentType<MarkdownViewProps>>(() =>
  import("./markdown-view-frame.js").then(
    (module) => ({ default: module.ViewFrame }),
    () => ({ default: ({ fallback }: MarkdownViewProps) => fallback }),
  ),
);

/**
 * A ```dx-view block: the agent's HTML document, framed in the reply. The
 * source toggle and copy button arrive as `actions`.
 */
export function MarkdownView(props: MarkdownViewProps) {
  return (
    <React.Suspense fallback={<div className="markdown-view-pending" />}>
      <ViewFrame {...props} />
    </React.Suspense>
  );
}
