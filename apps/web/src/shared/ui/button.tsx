import type { VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "../utils.js";
import { buttonVariants } from "./button-variants.js";

export function Button({
  className,
  variant,
  size,
  type = "button",
  ...props
}: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants>) {
  return (
    <button
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}
