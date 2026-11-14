import * as React from "react";
import type { PluginIcon as PluginIconComponent } from "./plugin-icon.js";

/**
 * `PluginIcon` for surfaces on the Thread page's first load (pane tabs, tool
 * rows, message tags): its code loads after first paint, and until then a
 * square of the same size holds its place, so nothing shifts.
 */

const Loaded = React.lazy(() =>
  import("./plugin-icon.js").then((module) => ({ default: module.PluginIcon })),
);

export function LazyPluginIcon(
  props: React.ComponentProps<typeof PluginIconComponent>,
) {
  return (
    <React.Suspense
      fallback={
        <span
          aria-hidden
          className={`plugin-icon ${props.className ?? ""}`}
          style={{
            display: "inline-block",
            width: props.size,
            height: props.size,
            flex: "none",
          }}
        />
      }
    >
      <Loaded {...props} />
    </React.Suspense>
  );
}
