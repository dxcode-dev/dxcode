import type * as React from "react";
import {
  PopoverContent,
  PopoverRoot,
  PopoverTrigger,
} from "../../../shared/ui/popover.js";

export function AutomationsPopover({
  trigger,
  triggerClassName,
  triggerLabel,
  above = false,
  children,
}: {
  readonly trigger: React.ReactNode;
  readonly triggerClassName: string;
  readonly triggerLabel: string;
  /** Opens upward from the transcript's end, left-aligned to the hint. */
  readonly above?: boolean;
  readonly children: React.ReactNode;
}) {
  return (
    <PopoverRoot>
      <PopoverTrigger
        className={triggerClassName}
        aria-label={triggerLabel}
        title={triggerLabel}
      >
        {trigger}
      </PopoverTrigger>
      <PopoverContent
        side={above ? "top" : "bottom"}
        align={above ? "start" : "end"}
        sideOffset={6}
        className="automation-popover"
      >
        {children}
      </PopoverContent>
    </PopoverRoot>
  );
}
