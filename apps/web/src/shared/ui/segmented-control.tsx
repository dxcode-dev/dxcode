import type * as React from "react";
import { cn } from "../utils.js";
import "./tabs.css";

/**
 * A pill group of plain buttons for a choice that is not a tab panel, such
 * as a filter: the chosen option has `aria-pressed`.
 */
export function SegmentedControl<Value extends string>({
  value,
  onValueChange,
  options,
  label,
  className,
}: {
  readonly value: Value;
  readonly onValueChange: (value: Value) => void;
  readonly options: ReadonlyArray<
    readonly [value: Value, label: React.ReactNode]
  >;
  readonly label: string;
  readonly className?: string;
}) {
  return (
    <fieldset
      aria-label={label}
      className={cn("dx-tabs-list dx-segmented", className)}
    >
      {options.map(([optionValue, optionLabel]) => (
        <button
          key={optionValue}
          type="button"
          className="dx-tab"
          aria-pressed={optionValue === value}
          data-active={optionValue === value || undefined}
          onClick={() => onValueChange(optionValue)}
        >
          {optionLabel}
        </button>
      ))}
    </fieldset>
  );
}
