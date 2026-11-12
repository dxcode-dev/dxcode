import type { McpAppView as McpAppViewData } from "@dx/api";
import * as React from "react";

export interface McpAppViewProps {
  readonly view: McpAppViewData;
  /** Unique to the call and card, such as `<toolCallId>:<index>`. */
  readonly cardKey: string;
}

/** The frame code loads with the first view or card, as one chunk. */
const McpAppFrame = React.lazy<React.ComponentType<McpAppViewProps>>(() =>
  import("./markdown-view-frame.js").then(
    (module) => ({ default: module.McpAppFrame }),
    () => ({ default: () => null }),
  ),
);

/** An MCP App's view, framed in its tool row. */
export function McpAppView(props: McpAppViewProps) {
  return (
    <React.Suspense fallback={<div className="markdown-view-pending" />}>
      <McpAppFrame {...props} />
    </React.Suspense>
  );
}
