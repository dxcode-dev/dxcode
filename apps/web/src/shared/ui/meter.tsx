import { cn } from "../utils.js";
import "./meter.css";

/** What a meter's fill means: plain, or a level the person should notice. */
export type MeterTone = "default" | "success" | "warning" | "danger";

/**
 * A thin bar filled to `value` of `max`, such as "$12 left of $20" or "80%
 * of a limit used". The caller says what the fill means with `label` and
 * `valueText`; `tone` colors a level (low, out, over). `decorative` hides it
 * from assistive tech when the number beside it already says the same.
 */
export function Meter({
  value,
  max,
  label,
  valueText,
  tone = "default",
  size = "md",
  decorative = false,
  className,
}: {
  readonly value: number;
  readonly max: number;
  /** Names the meter for assistive tech: "Model balance left". */
  readonly label?: string;
  /** The value in words: "$12.00 left of $20.00". */
  readonly valueText?: string;
  readonly tone?: MeterTone;
  /** sm 4px, for a row or a list; md 6px, for a card. */
  readonly size?: "sm" | "md";
  readonly decorative?: boolean;
  readonly className?: string;
}) {
  const ceiling = max > 0 ? max : 0;
  const clamped = Math.min(Math.max(value, 0), ceiling);
  const percent = ceiling === 0 ? 0 : (clamped / ceiling) * 100;
  return (
    <span
      className={cn("dx-meter", className)}
      data-tone={tone === "default" ? undefined : tone}
      data-size={size}
      {...(decorative
        ? { "aria-hidden": true }
        : {
            role: "meter",
            "aria-label": label,
            "aria-valuemin": 0,
            "aria-valuemax": ceiling,
            "aria-valuenow": clamped,
            ...(valueText === undefined ? {} : { "aria-valuetext": valueText }),
          })}
    >
      <span className="dx-meter-fill" style={{ width: `${percent}%` }} />
    </span>
  );
}
