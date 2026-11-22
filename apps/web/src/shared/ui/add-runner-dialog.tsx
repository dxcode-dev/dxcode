import { CircleCheck, LoaderCircle } from "lucide-react";
import { Button } from "./button.js";
import { CommandBlock } from "./command-block.js";
import {
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
} from "./dialog.js";
import "./add-runner-dialog.css";

const expiryFormat = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });
const formatExpiry = (expiresAt: number) => expiryFormat.format(expiresAt);

/**
 * Pairs a new machine (a runner): the one command that installs the runner
 * and connects it to the person's account, its code's expiry, and whether
 * the machine has connected yet. With `onUse`, the button picks the new
 * machine (the New Thread Orb picker); else it closes.
 */
export function AddRunnerDialog({
  open,
  pairing,
  error,
  connectedName,
  stacked = false,
  onRetry,
  onClose,
  onUse,
}: {
  readonly open: boolean;
  /** The command and when its code expires (epoch ms); undefined while it loads. */
  readonly pairing:
    | { readonly command: string; readonly expiresAt: number }
    | undefined;
  /** Why no code could be made. */
  readonly error?: string;
  /** The machine that connected since the dialog opened. */
  readonly connectedName?: string;
  /** Over another dialog, such as the New Thread composer. */
  readonly stacked?: boolean;
  readonly onRetry: () => void;
  readonly onClose: () => void;
  readonly onUse?: () => void;
}) {
  return (
    <DialogRoot
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      {open ? (
        <DialogContent size="md" stacked={stacked}>
          <div className="add-runner">
            <DialogTitle>Add a runner</DialogTitle>
            <DialogDescription>
              Run this in a terminal on the Mac or Linux machine your Threads
              should run on. It installs the runner under ~/.dx and connects it
              to your account. No sudo.
            </DialogDescription>
            {error === undefined ? (
              <CommandBlock
                label="Install command"
                command={pairing?.command ?? "Creating a pairing code…"}
                disabled={pairing === undefined}
              />
            ) : (
              <div className="add-runner-error" role="alert">
                <span>{error}</span>
                <Button
                  size="xs"
                  variant="outline"
                  type="button"
                  onClick={onRetry}
                >
                  Retry
                </Button>
              </div>
            )}
            <p className="add-runner-note">
              Works on Apple silicon Macs and Linux.
              {pairing === undefined
                ? null
                : ` The code works once, until ${formatExpiry(pairing.expiresAt)}.`}
            </p>
            <p className="add-runner-status" aria-live="polite">
              {connectedName === undefined ? (
                <>
                  <LoaderCircle className="spin" aria-hidden="true" />
                  Waiting for the machine to connect…
                </>
              ) : (
                <>
                  <CircleCheck aria-hidden="true" data-tone="success" />
                  Connected: {connectedName}
                </>
              )}
            </p>
            <footer className="add-runner-actions">
              {connectedName !== undefined && onUse !== undefined ? (
                <Button size="sm" type="button" onClick={onUse}>
                  Use {connectedName}
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant={connectedName === undefined ? "ghost" : "default"}
                  type="button"
                  onClick={onClose}
                >
                  {connectedName === undefined ? "Close" : "Done"}
                </Button>
              )}
            </footer>
          </div>
        </DialogContent>
      ) : null}
    </DialogRoot>
  );
}
