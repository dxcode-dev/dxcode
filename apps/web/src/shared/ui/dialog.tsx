import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import type * as React from "react";
import { cn } from "../utils.js";
import type { OverlayLayer } from "./sheet.js";
import "./dialog.css";
import "./overlay.css";

export const DialogRoot = Dialog.Root;
export const DialogTitle = Dialog.Title;
export const DialogDescription = Dialog.Description;
export const DialogClose = Dialog.Close;
export const DialogTrigger = Dialog.Trigger;

type PopupProps = React.ComponentProps<typeof Dialog.Popup>;

/**
 * dx's centered dialog surface, for a short task that needs the page's
 * attention. Confirmations use `ConfirmDialog`; longer side tasks use
 * `SheetContent`. `size` sets the width: `sm` 430px (default), `md` 480px,
 * `lg` 520px, `xl` 720px for wide content such as a review; `page` fills
 * the window, less a margin, for a flow that takes over the page, such as
 * creating a Space.
 */
export function DialogContent({
  children,
  className,
  backdropClassName,
  viewportClassName,
  size = "sm",
  layer,
  stacked = false,
  initialFocus,
  finalFocus,
  showClose = true,
  "aria-label": ariaLabel,
}: {
  readonly children: React.ReactNode;
  readonly className?: string;
  readonly backdropClassName?: string;
  readonly viewportClassName?: string;
  readonly size?: "sm" | "md" | "lg" | "xl" | "page";
  /** Where it sits among the other overlays; see `OverlayLayer`. */
  readonly layer?: OverlayLayer;
  /** Over another overlay on the same layer, such as a picker it opened. */
  readonly stacked?: boolean;
  readonly initialFocus?: PopupProps["initialFocus"];
  readonly finalFocus?: PopupProps["finalFocus"];
  /** The corner close button; leave it on unless the dialog draws its own. */
  readonly showClose?: boolean;
  readonly "aria-label"?: string;
}) {
  const layered = {
    "data-layer": layer,
    "data-stacked": stacked || undefined,
  };
  return (
    <Dialog.Portal>
      <Dialog.Backdrop
        className={cn("dialog-backdrop", backdropClassName)}
        {...layered}
      />
      <Dialog.Viewport
        className={cn("dialog-viewport", viewportClassName)}
        data-size={size}
        {...layered}
      >
        <Dialog.Popup
          className={cn("dialog-popup", className)}
          data-size={size}
          initialFocus={initialFocus}
          finalFocus={finalFocus}
          aria-label={ariaLabel}
        >
          {children}
          {showClose ? (
            <Dialog.Close className="dialog-close" aria-label="Close dialog">
              <X />
            </Dialog.Close>
          ) : null}
        </Dialog.Popup>
      </Dialog.Viewport>
    </Dialog.Portal>
  );
}
