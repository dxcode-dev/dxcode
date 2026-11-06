import { lazyRouteComponent } from "@tanstack/react-router";

// Most Thread page loads never show Preview, so the Portals pane loads when
// it first renders. `lazyRouteComponent` (not React.lazy) reloads the page
// once if a deploy removed the chunk.
export const ThreadPortalsPane = lazyRouteComponent(
  () => import("./portals-pane.js"),
  "ThreadPortalsPane",
);

/** Loads the pane's code ahead of its first render, as Changes does. */
export const preloadPortalsPane = async () => {
  await ThreadPortalsPane.preload?.();
};
