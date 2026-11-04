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
 * dialog once the action succeeds, so a failed action leaves it open and
 * shows `error`.
 *
 * `children` sit between the description and the buttons, for what the
 * confirmation needs besides a yes: a choice, a typed name, "Don't ask me
 * again".
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  error,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  pending = false,
  confirmDisabled = false,
  onConfirm,
  initialFocus,
  finalFocus,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: React.ReactNode;
  readonly description?: React.ReactNode;
  readonly children?: React.ReactNode;
  /** Why the last attempt failed. */
  readonly error?: string;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  /** Styles Confirm as a destructive action, such as a deletion. */
  readonly destructive?: boolean;
  /** Disables both buttons while the action runs. */
  readonly pending?: boolean;
  /** Disables Confirm until the confirmation is complete, such as a typed name. */
  readonly confirmDisabled?: boolean;
  readonly onConfirm: () => void;
  /** Focused on open instead of the first button or field. */
  readonly initialFocus?: React.RefObject<HTMLElement | null>;
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
        {/* Rendered when nested too: a confirmation from inside another
            dialog dims that dialog. */}
        <Dialog.Backdrop className="confirm-dialog-backdrop" forceRender />
        <Dialog.Viewport className="confirm-dialog-viewport">
          <Dialog.Popup
            className="confirm-dialog"
            initialFocus={initialFocus}
            finalFocus={finalFocus}
          >
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
            {children === undefined ? null : (
              <div className="confirm-dialog-body">{children}</div>
            )}
            {error === undefined ? null : (
              <p className="confirm-dialog-error" role="alert">
                {error}
              </p>
            )}
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
                disabled={pending || confirmDisabled}
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
