import type { ThreadColor } from "@dx/domain";
import { Orbit } from "lucide-react";
import { cn } from "../../shared/utils.js";

/** A Space's mark: an orbit in the Space's color. */
export function SpaceIcon({
  color,
  className,
}: {
  readonly color: ThreadColor;
  readonly className?: string;
}) {
  return (
    <Orbit
      className={cn("space-icon", className)}
      data-thread-color={color}
      aria-hidden="true"
    />
  );
}
