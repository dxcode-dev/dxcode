import { Drawer } from "@base-ui/react/drawer";
import type * as React from "react";
import { cn } from "../utils.js";
import type { OverlayLayer } from "./sheet.js";
import "./overlay.css";

/**
 * dx's drawer: a bottom sheet a finger can swipe down, with a grab bar at
 * its top, for details on a phone, such as a Space's. For a panel from the
 * side, use `SheetContent`.
 */
export const DrawerRoot = Drawer.Root;

export function DrawerContent({
  children,
  className,
  layer = "dialog",
  handleLabel = "Close",
  "aria-label": ariaLabel,
}: {
  readonly children: React.ReactNode;
  readonly className?: string;
  readonly layer?: OverlayLayer;
  /** What the grab bar says to assistive tech; pressing it closes. */
  readonly handleLabel?: string;
  readonly "aria-label"?: string;
}) {
  return (
    <Drawer.Portal>
      <Drawer.Backdrop className="dx-drawer-backdrop" data-layer={layer} />
      <Drawer.Viewport className="dx-drawer-viewport" data-layer={layer}>
        <Drawer.Popup
          className={cn("dx-drawer", className)}
          aria-label={ariaLabel}
        >
          <Drawer.Close className="dx-drawer-handle" aria-label={handleLabel}>
            <span />
          </Drawer.Close>
          <Drawer.Content className="dx-drawer-content">
            {children}
          </Drawer.Content>
        </Drawer.Popup>
      </Drawer.Viewport>
    </Drawer.Portal>
  );
}
