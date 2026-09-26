import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import type * as React from "react";
import { cn } from "../utils.js";

export function ModalSurface({
  children,
  className,
  ariaLabel,
  initialFocus,
  finalFocus,
}: {
  readonly children: React.ReactNode;
  readonly className?: string;
  readonly ariaLabel?: string;
  readonly initialFocus?: React.ComponentProps<
    typeof Dialog.Popup
  >["initialFocus"];
  readonly finalFocus?: React.ComponentProps<typeof Dialog.Popup>["finalFocus"];
}) {
  return (
    <Dialog.Portal>
      <Dialog.Backdrop className="modal-surface-backdrop" />
      <Dialog.Viewport className="modal-surface-viewport">
        <Dialog.Popup
          className={cn("modal-surface-popup", className)}
          aria-label={ariaLabel}
          initialFocus={initialFocus}
          finalFocus={finalFocus}
        >
          {children}
        </Dialog.Popup>
      </Dialog.Viewport>
    </Dialog.Portal>
  );
}

export function ModalSurfaceHeader({
  children,
  className,
}: {
  readonly children: React.ReactNode;
  readonly className?: string;
}) {
  return (
    <header className={cn("modal-surface-header", className)}>
      {children}
    </header>
  );
}

export function ModalSurfaceClose() {
  return (
    <Dialog.Close className="modal-surface-header-action">
      <X aria-hidden="true" /> Close
    </Dialog.Close>
  );
}
