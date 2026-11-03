import { lazyRouteComponent } from "@tanstack/react-router";

// The diff viewer and its highlighter are the largest code on the Thread
// page, and most Threads never open Changes, so they load when this pane
// first renders. `lazyRouteComponent` (not React.lazy) reloads the page once
// if a deploy removed the chunk.
export const ChangesPaneContent = lazyRouteComponent(
  () => import("./changes-pane-content.js"),
  "ChangesPaneContent",
);

/**
 * Loads the pane's code ahead of its first render, which then needs no
 * fallback. `preload` is gone once the code has loaded.
 */
export const preloadChangesPane = async () => {
  await ChangesPaneContent.preload?.();
};
