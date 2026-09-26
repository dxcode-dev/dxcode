import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import type * as React from "react";
import { cn } from "../utils.js";

export const DialogRoot = Dialog.Root;
export const DialogTitle = Dialog.Title;
export const DialogDescription = Dialog.Description;

export function DialogContent({
  children,
  className,
  backdropClassName,
  finalFocus,
}: {
  readonly children: React.ReactNode;
  readonly className?: string;
  readonly backdropClassName?: string;
  readonly finalFocus?: React.RefObject<HTMLElement | null>;
}) {
  return (
    <Dialog.Portal>
      <Dialog.Backdrop className={cn("dialog-backdrop", backdropClassName)} />
      <Dialog.Viewport className="dialog-viewport">
        <Dialog.Popup
          className={cn("dialog-popup", className)}
          finalFocus={finalFocus}
        >
          {children}
          <Dialog.Close className="dialog-close" aria-label="Close dialog">
            <X />
          </Dialog.Close>
        </Dialog.Popup>
      </Dialog.Viewport>
    </Dialog.Portal>
  );
}
