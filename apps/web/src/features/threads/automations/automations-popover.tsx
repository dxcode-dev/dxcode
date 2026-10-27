import { Popover } from "@base-ui/react/popover";
import type * as React from "react";

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
    <Popover.Root>
      <Popover.Trigger
        className={triggerClassName}
        aria-label={triggerLabel}
        title={triggerLabel}
      >
        {trigger}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          className="automation-popover-positioner"
          side={above ? "top" : "bottom"}
          align={above ? "start" : "end"}
          sideOffset={6}
        >
          <Popover.Popup className="automation-popover">
            {children}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
