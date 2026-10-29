import * as React from "react";

/**
 * Where the shown tab's toolbar renders: the end of its pane's tab strip, or
 * the end of the stacked layout's view row. Null when the tab is hidden or
 * there is no strip, so the toolbar renders in place.
 */
export const PaneToolbarSlotContext = React.createContext<HTMLElement | null>(
  null,
);
