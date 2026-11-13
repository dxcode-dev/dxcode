import type { VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "../utils.js";
import { buttonVariants } from "./button-variants.js";

/**
 * dx's button. `variant` sets its weight, `size` its height, `shape="round"`
 * makes a pill or circle, `block` fills the row, `tone` tints a meaningful
 * state, and `busy` shows an action under way. See button.css.
 */
export function Button({
  className,
  variant,
  size,
  block,
  shape,
  tone,
  busy = false,
  type = "button",
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    /** An action under way, such as sending or recording. */
    readonly busy?: boolean;
  }) {
  return (
    <button
      type={type}
      className={cn(
        buttonVariants({ variant, size, block, shape, tone }),
        className,
      )}
      data-busy={busy || undefined}
      aria-busy={busy || undefined}
      {...props}
    />
  );
}
