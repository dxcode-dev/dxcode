import * as React from "react";
import { createPortal } from "react-dom";
import { PaneToolbarSlotContext } from "./pane-toolbar-slot-context.js";

/** Renders a tab's toolbar into its pane's strip when there is one. */
export function PaneToolbar({
  children,
  className,
}: {
  readonly children: React.ReactNode;
  /** Wraps the in-place rendering when no strip takes the toolbar. */
  readonly className?: string;
}) {
  const slot = React.useContext(PaneToolbarSlotContext);
  if (slot !== null) return createPortal(children, slot);
  return <div className={className}>{children}</div>;
}
