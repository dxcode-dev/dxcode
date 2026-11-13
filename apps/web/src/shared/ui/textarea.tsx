import type * as React from "react";
import { cn } from "../utils.js";
import "./form-controls.css";

/**
 * A multi-line text field. `mono` sets code type (monospace, 2-space tabs,
 * no wrapping) for scripts and config; `variant="bare"` drops the border and
 * fill for a field inside a composite control that draws its own frame.
 */
export function Textarea({
  className,
  mono = false,
  variant = "default",
  ...props
}: React.ComponentProps<"textarea"> & {
  readonly mono?: boolean;
  readonly variant?: "default" | "bare";
}) {
  return (
    <textarea
      className={cn("dx-textarea", className)}
      data-mono={mono || undefined}
      data-variant={variant === "bare" ? "bare" : undefined}
      {...props}
    />
  );
}
