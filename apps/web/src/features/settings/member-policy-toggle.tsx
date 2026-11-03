import * as React from "react";
import { ConfirmDialog } from "../../shared/ui/confirm-dialog.js";
import { SettingsToggle } from "./settings-primitives.js";

/**
 * A workspace switch that decides whether members may use their own
 * resources. Every change asks first: the click opens an "Allow …?" or
 * "Block …?" dialog, and only its Allow or Block button calls `onConfirm`.
 * The dialog stays open when `onConfirm` reports a failure.
 */
export function MemberPolicyToggle({
  checked,
  disabled = false,
  pending = false,
  label,
  subject,
  description,
  onConfirm,
}: {
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly pending?: boolean;
  readonly label: string;
  /** What the policy covers, as the dialog title names it: "personal skills". */
  readonly subject: string;
  readonly description: string;
  /** Saves the policy; resolves true once it is saved. */
  readonly onConfirm: (allowed: boolean) => Promise<boolean>;
}) {
  const [confirming, setConfirming] = React.useState<boolean>();
  return (
    <>
      <SettingsToggle
        checked={checked}
        disabled={disabled}
        pending={pending}
        label={label}
        onCheckedChange={setConfirming}
      />
      <ConfirmDialog
        open={confirming !== undefined}
        onOpenChange={(open) => {
          if (!open) setConfirming(undefined);
        }}
        title={`${confirming ? "Allow" : "Block"} ${subject}?`}
        description={description}
        confirmLabel={confirming ? "Allow" : "Block"}
        pending={pending || (confirming !== undefined && disabled)}
        onConfirm={async () => {
          if (confirming === undefined) return;
          if (await onConfirm(confirming)) setConfirming(undefined);
        }}
      />
    </>
  );
}
