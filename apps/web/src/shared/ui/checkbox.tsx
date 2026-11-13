import type * as React from "react";
import { cn } from "../utils.js";
import "./form-controls.css";

/** An on/off box. Wrap it in a `<label>` with its text. */
export function Checkbox({
  className,
  ...props
}: Omit<React.ComponentProps<"input">, "type">) {
  return (
    <input
      type="checkbox"
      className={cn("dx-checkbox", className)}
      {...props}
    />
  );
}

/** One choice of a set sharing a `name`. Wrap it in a `<label>`. */
export function Radio({
  className,
  ...props
}: Omit<React.ComponentProps<"input">, "type">) {
  return (
    <input type="radio" className={cn("dx-radio", className)} {...props} />
  );
}
