import { cn } from "../utils.js";
import "./form-controls.css";

/**
 * An on/off switch that acts at once, such as a setting. `pending` shows
 * `checked` while it saves and ignores presses until it settles; it stays
 * focusable, so keyboard focus does not jump away mid-save.
 */
export function Switch({
  checked,
  onCheckedChange,
  label,
  disabled = false,
  pending = false,
  describedBy,
  className,
}: {
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
  readonly label: string;
  readonly disabled?: boolean;
  readonly pending?: boolean;
  /** Id of the hint that explains the switch's state. */
  readonly describedBy?: string;
  readonly className?: string;
}) {
  return (
    <button
      type="button"
      className={cn("dx-switch", className)}
      data-checked={checked || undefined}
      data-pending={pending || undefined}
      aria-label={label}
      aria-pressed={checked}
      aria-busy={pending || undefined}
      aria-disabled={pending || undefined}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={() => {
        if (!pending) onCheckedChange(!checked);
      }}
    >
      <span />
    </button>
  );
}
