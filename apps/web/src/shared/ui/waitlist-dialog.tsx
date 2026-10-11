import { Hourglass } from "lucide-react";
import { Button } from "./button.js";
import {
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
} from "./dialog.js";
import "./waitlist-dialog.css";

/** Confirms that an address joined (or is still on) the waitlist. */
export function WaitlistDialog({
  open,
  email,
  onClose,
}: {
  readonly open: boolean;
  /** Unknown after a Google redirect, which carries only the outcome. */
  readonly email?: string;
  readonly onClose: () => void;
}) {
  return (
    <DialogRoot
      open={open}
      onOpenChange={(next) => (next ? undefined : onClose())}
    >
      <DialogContent className="waitlist-dialog">
        <div className="waitlist-dialog-icon" aria-hidden="true">
          <Hourglass />
        </div>
        <DialogTitle>You're on the waitlist</DialogTitle>
        <DialogDescription>
          {email === undefined ? (
            "Thanks for your interest in dx. We'll email you as soon as your account is ready."
          ) : (
            <>
              Thanks for your interest in dx. We'll email{" "}
              <strong>{email}</strong> as soon as your account is ready.
            </>
          )}
        </DialogDescription>
        <p className="waitlist-dialog-note">
          Have a workspace invite link? Open it to skip the line.
        </p>
        <Button className="waitlist-dialog-action" onClick={onClose}>
          Got it
        </Button>
      </DialogContent>
    </DialogRoot>
  );
}
