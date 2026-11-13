import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import type * as React from "react";
import { cn } from "../utils.js";
import "./overlay.css";

/**
 * dx's sheet: a panel that slides in from an edge for a longer task beside
 * the page, such as editing a server or a provider, or the phone's sidebar.
 * Open it with `SheetRoot`'s `open`. For a bottom sheet a finger can swipe
 * away, use `DrawerContent`.
 */
export const SheetRoot = Dialog.Root;
export const SheetTrigger = Dialog.Trigger;
export const SheetClose = Dialog.Close;
export const SheetTitle = Dialog.Title;
export const SheetDescription = Dialog.Description;

type PopupProps = React.ComponentProps<typeof Dialog.Popup>;

/**
 * Where an overlay sits among the others. `dialog` (a sheet's default) is
 * over the page's dialogs; `panel` is under them, for a full-screen panel
 * that its own dialogs and menus open over. `stacked` lifts one overlay over
 * another on the same layer, such as a picker over the dialog that opened it.
 */
export type OverlayLayer = "panel" | "dialog";

export function SheetContent({
  title,
  description,
  actions,
  children,
  className,
  backdropClassName,
  side = "right",
  size = "side",
  inset = false,
  padded = true,
  layer = "dialog",
  stacked = false,
  keepMounted,
  popupRef,
  backdropRef,
  initialFocus,
  finalFocus,
  "aria-label": ariaLabel,
}: {
  /** The sheet's heading; leave it out to draw your own header. */
  readonly title?: React.ReactNode;
  readonly description?: React.ReactNode;
  /** Controls beside the close button in the header. */
  readonly actions?: React.ReactNode;
  readonly children: React.ReactNode;
  readonly className?: string;
  readonly backdropClassName?: string;
  /** The edge it slides from. */
  readonly side?: "right" | "left";
  /** `full` fills the screen at every width, such as a phone's editor. */
  readonly size?: "side" | "full";
  /** Floats a rounded card off the edge instead of a full-height panel. */
  readonly inset?: boolean;
  /** Pads and scrolls the body; turn it off for content that lays itself out. */
  readonly padded?: boolean;
  readonly layer?: OverlayLayer;
  readonly stacked?: boolean;
  /** Keeps the sheet in the page while closed, such as for a drag to open. */
  readonly keepMounted?: boolean;
  readonly popupRef?: React.Ref<HTMLDivElement>;
  readonly backdropRef?: React.Ref<HTMLDivElement>;
  readonly initialFocus?: PopupProps["initialFocus"];
  readonly finalFocus?: PopupProps["finalFocus"];
  readonly "aria-label"?: string;
}) {
  const layered = {
    "data-layer": layer,
    "data-stacked": stacked || undefined,
  };
  return (
    <Dialog.Portal keepMounted={keepMounted}>
      <Dialog.Backdrop
        ref={backdropRef}
        className={cn("dx-sheet-backdrop", backdropClassName)}
        {...layered}
      />
      <Dialog.Viewport
        className="dx-sheet-viewport"
        data-side={side}
        {...layered}
      >
        <Dialog.Popup
          ref={popupRef}
          className={cn("dx-sheet", className)}
          data-size={size}
          data-side={side}
          data-inset={inset || undefined}
          initialFocus={initialFocus}
          finalFocus={finalFocus}
          aria-label={ariaLabel}
        >
          {title === undefined ? null : (
            <header className="dx-sheet-header">
              <div className="dx-sheet-heading">
                <Dialog.Title className="dx-sheet-title">{title}</Dialog.Title>
                {description === undefined ? null : (
                  <Dialog.Description className="dx-sheet-description">
                    {description}
                  </Dialog.Description>
                )}
              </div>
              {actions}
              <Dialog.Close className="dx-sheet-close" aria-label="Close">
                <X aria-hidden="true" />
              </Dialog.Close>
            </header>
          )}
          {padded ? <div className="dx-sheet-body">{children}</div> : children}
        </Dialog.Popup>
      </Dialog.Viewport>
    </Dialog.Portal>
  );
}
