import { lazyRouteComponent } from "@tanstack/react-router";
import * as React from "react";
import type { NewProject } from "./new-project.js";

// The New Project dialog loads the first time it opens, not with every page.
// `lazyRouteComponent` reloads the page once if a deploy removed the chunk.
const NewProjectDialog = lazyRouteComponent(
  () => import("./new-project.js"),
  "NewProject",
);

/**
 * `NewProject` for the New Project surface: nothing until it first opens,
 * then the dialog, which stays mounted so it animates closed.
 */
export function NewProjectOnDemand(
  props: React.ComponentProps<typeof NewProject>,
) {
  const [opened, setOpened] = React.useState(false);
  if (props.open && !opened) setOpened(true);
  return opened ? (
    <React.Suspense fallback={null}>
      <NewProjectDialog {...props} />
    </React.Suspense>
  ) : null;
}
