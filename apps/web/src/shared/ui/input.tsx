import type * as React from "react";
import { cn } from "../utils.js";
import "./form-controls.css";

type ControlSize = "sm" | "md" | "lg";

/**
 * A text field. `size` picks its height: 28, 32, or 36 (default) px. `mono`
 * sets code type, as for an ID or a path; `variant="bare"` drops the frame,
 * fill, height, and type for a field inside a control that draws its own,
 * such as a search bar or an inline title editor.
 */
export function Input({
  className,
  size = "lg",
  mono = false,
  variant = "default",
  ...props
}: Omit<React.ComponentProps<"input">, "size"> & {
  readonly size?: ControlSize;
  readonly mono?: boolean;
  readonly variant?: "default" | "bare";
}) {
  return (
    <input
      className={cn("dx-input", className)}
      data-size={size}
      data-mono={mono || undefined}
      data-variant={variant === "bare" ? "bare" : undefined}
      {...props}
    />
  );
}
