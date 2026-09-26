import { DxMark } from "./dx-mark.js";

/** Shows the dx loading mark as an inline status or full-screen transition. */
export function DxLoading({
  active = true,
  label,
  variant = "inline",
}: {
  readonly active?: boolean;
  readonly label: string;
  readonly variant?: "inline" | "screen";
}) {
  if (!active) return null;
  return (
    <div
      className={`dx-loading dx-loading-${variant} is-loading`}
      role="status"
      aria-label={label}
      aria-live="polite"
    >
      <DxMark state="loading" label="" />
      {variant === "inline" ? (
        <strong className="dx-loading-label">{label}</strong>
      ) : null}
    </div>
  );
}
