import type * as React from "react";
import { cn } from "../utils.js";
import "./form-controls.css";

export type SelectOption = readonly [value: string, label: string];

/**
 * A native choice list, so phones show their own picker. Pass `options`, or
 * `<option>` children for groups. `size` picks its height: 28 (default) or
 * 32 px.
 */
export function Select({
  className,
  options,
  children,
  size = "sm",
  onValueChange,
  onChange,
  ...props
}: Omit<React.ComponentProps<"select">, "size"> & {
  readonly options?: ReadonlyArray<SelectOption>;
  readonly size?: "sm" | "md";
  readonly onValueChange?: (value: string) => void;
}) {
  return (
    <select
      className={cn("dx-select", className)}
      data-size={size}
      onChange={(event) => {
        onChange?.(event);
        onValueChange?.(event.target.value);
      }}
      {...props}
    >
      {options?.map(([value, label]) => (
        <option key={value} value={value}>
          {label}
        </option>
      ))}
      {children}
    </select>
  );
}
