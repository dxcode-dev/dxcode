import type { ThreadPaneLayout } from "@dx/api";
import {
  defaultPaneLayout,
  type PaneViewKind,
  reducePaneLayout,
} from "../features/threads/panes/pane-layout.js";

/** A layout with the given views open in the right pane, the first active. */
export const paneLayoutWith = (
  views: ReadonlyArray<PaneViewKind>,
): ThreadPaneLayout => {
  let layout = defaultPaneLayout();
  for (const view of views)
    layout = reducePaneLayout(layout, { type: "open-view", view });
  const first = views[0];
  return first === undefined
    ? layout
    : reducePaneLayout(layout, {
        type: "activate",
        pane: "p1",
        tab: first === "terminal" ? "terminal:1" : first,
      });
};
