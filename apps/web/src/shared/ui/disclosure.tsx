import { ChevronDown } from "lucide-react";
import type * as React from "react";
import { cn } from "../utils.js";
import "./disclosure.css";

/**
 * The row that shows or hides more below it, such as a message's source or
 * a GitHub event: a muted leading icon and label, then a chevron that turns
 * when open. The caller owns `expanded` and renders the content.
 */
export function DisclosureTrigger({
  expanded,
  className,
  children,
  type = "button",
  ...props
}: React.ComponentProps<"button"> & {
  readonly expanded: boolean;
}) {
  return (
    <button
      type={type}
      className={cn("dx-disclosure", className)}
      aria-expanded={expanded}
      {...props}
    >
      {children}
      <ChevronDown className="dx-disclosure-chevron" aria-hidden="true" />
    </button>
  );
}
