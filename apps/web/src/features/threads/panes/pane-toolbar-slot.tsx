import * as React from "react";
import { createPortal } from "react-dom";
import {
  PaneTabSlotContext,
  PaneToolbarSlotContext,
} from "./pane-toolbar-slot-context.js";

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

const noSlots = () => () => undefined;
const noSlot = () => null;

/**
 * Renders controls that belong to the shown tab itself inside its tab in the
 * stacked view row; renders nothing where no tab offers a slot.
 */
export function PaneTabAccessory({
  children,
}: {
  readonly children: React.ReactNode;
}) {
  const shown = React.useContext(PaneTabSlotContext);
  const slot = React.useSyncExternalStore(
    shown?.slots.subscribe ?? noSlots,
    shown === null ? noSlot : () => shown.slots.get(shown.tabId),
    noSlot,
  );
  return slot === null ? null : createPortal(children, slot);
}
