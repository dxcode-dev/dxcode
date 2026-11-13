import type { VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "../utils.js";
import { chipVariants } from "./chip-variants.js";

/**
 * A rounded pill that acts or toggles: a reaction, a quick suggestion, a
 * composer setting. With `aria-pressed`, the pressed chip is highlighted.
 */
export function Chip({
  className,
  variant,
  size,
  type = "button",
  ...props
}: React.ComponentProps<"button"> & VariantProps<typeof chipVariants>) {
  return (
    <button
      type={type}
      className={cn(chipVariants({ variant, size }), className)}
      {...props}
    />
  );
}
