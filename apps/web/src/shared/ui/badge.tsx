import type * as React from "react";
import { cn } from "../utils.js";
import "./display.css";

export type BadgeTone = "neutral" | "info" | "success" | "warning" | "danger";

/**
 * A short label beside a name: a status, a kind, a count, a version.
 * `tone` colors it; neutral by default.
 */
export function Badge({
  className,
  tone = "neutral",
  ...props
}: React.ComponentProps<"span"> & {
  readonly tone?: BadgeTone;
}) {
  return (
    <span className={cn("dx-badge", className)} data-tone={tone} {...props} />
  );
}
