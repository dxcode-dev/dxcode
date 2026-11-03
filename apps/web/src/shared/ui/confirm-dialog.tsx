import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import type * as React from "react";
import "./confirm-dialog.css";

/**
 * The dialog that asks before an action takes effect: a title, one line on
 * what follows, and Cancel beside the confirming button. Use it for every
 * confirmation instead of composing DialogContent by hand.
 *
 * Cancel, Escape, the close button, and a backdrop click call
 * `onOpenChange(false)`. Confirm calls `onConfirm`; the caller closes the
 * dialog once the action succeeds, so a failed action leaves it open.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  pending = false,
  onConfirm,
  finalFocus,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: React.ReactNode;
  readonly description?: React.ReactNode;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  /** Styles Confirm as a destructive action, such as a deletion. */
  readonly destructive?: boolean;
  /** Disables both buttons while the action runs. */
  readonly pending?: boolean;
  readonly onConfirm: () => void;
  readonly finalFocus?: React.RefObject<HTMLElement | null>;
}) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!pending || next) onOpenChange(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="confirm-dialog-backdrop" />
        <Dialog.Viewport className="confirm-dialog-viewport">
          <Dialog.Popup className="confirm-dialog" finalFocus={finalFocus}>
            <header className="confirm-dialog-header">
              <Dialog.Title className="confirm-dialog-title">
                {title}
              </Dialog.Title>
              {description === undefined ? null : (
                <Dialog.Description className="confirm-dialog-description">
                  {description}
                </Dialog.Description>
              )}
            </header>
            <footer className="confirm-dialog-footer">
              <Dialog.Close
                className="confirm-dialog-button"
                disabled={pending}
              >
                {cancelLabel}
              </Dialog.Close>
              <button
                type="button"
                className="confirm-dialog-button"
                data-tone={destructive ? "destructive" : "primary"}
                disabled={pending}
                aria-busy={pending || undefined}
                onClick={onConfirm}
              >
                {confirmLabel}
              </button>
            </footer>
            <Dialog.Close
              className="confirm-dialog-close"
              aria-label="Close dialog"
              disabled={pending}
            >
              <X />
            </Dialog.Close>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
