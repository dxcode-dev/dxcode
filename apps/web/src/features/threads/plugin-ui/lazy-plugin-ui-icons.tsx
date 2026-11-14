import * as React from "react";
import type * as Icons from "./plugin-ui-icons.js";

/**
 * The plugin icons on the Thread page's first-load surfaces (pane tabs, the
 * Views menu, tool rows), loaded after first paint: a tab keeps a square of
 * the icon's size meanwhile, and a tool row adds its icon when it arrives.
 */

const load = () => import("./plugin-ui-icons.js");

const PaneIcon = React.lazy(() =>
  load().then((module) => ({ default: module.PluginPaneIcon })),
);
const RoutePaneIcon = React.lazy(() =>
  load().then((module) => ({ default: module.RoutePluginPaneIcon })),
);
const ToolIcon = React.lazy(() =>
  load().then((module) => ({ default: module.PluginToolIcon })),
);

const square = (
  <span
    aria-hidden
    className="plugin-icon"
    style={{ display: "inline-block", width: 16, height: 16, flex: "none" }}
  />
);

export function PluginPaneIcon(
  props: React.ComponentProps<typeof Icons.PluginPaneIcon>,
) {
  return (
    <React.Suspense fallback={square}>
      <PaneIcon {...props} />
    </React.Suspense>
  );
}

export function RoutePluginPaneIcon(
  props: React.ComponentProps<typeof Icons.RoutePluginPaneIcon>,
) {
  return (
    <React.Suspense fallback={square}>
      <RoutePaneIcon {...props} />
    </React.Suspense>
  );
}

export function PluginToolIcon(
  props: React.ComponentProps<typeof Icons.PluginToolIcon>,
) {
  return (
    <React.Suspense fallback={null}>
      <ToolIcon {...props} />
    </React.Suspense>
  );
}
