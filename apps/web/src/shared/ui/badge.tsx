import type * as React from "react";
import { cn } from "../utils.js";

export function Badge({ className, ...props }: React.ComponentProps<"span">) {
  return <span className={cn("badge", className)} {...props} />;
}
