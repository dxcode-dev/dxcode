import { lazyRouteComponent } from "@tanstack/react-router";
import * as React from "react";
import type { ThreadSearchDialog } from "./thread-search-dialog.js";

// Thread search loads when it first opens. `lazyRouteComponent` reloads the
// page once if a deploy removed the chunk.
const ThreadSearch = lazyRouteComponent(
  () => import("./thread-search-dialog.js"),
  "ThreadSearchDialog",
);

/**
 * `ThreadSearchDialog`, mounted the first time it opens and kept mounted
 * after, so it keeps its query and animates closed.
 */
export function ThreadSearchOnDemand(
  props: React.ComponentProps<typeof ThreadSearchDialog>,
) {
  const [opened, setOpened] = React.useState(false);
  if (props.open && !opened) setOpened(true);
  return opened ? (
    <React.Suspense fallback={null}>
      <ThreadSearch {...props} />
    </React.Suspense>
  ) : null;
}
