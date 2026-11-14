import type * as React from "react";
import { useMountEffect } from "../../../shared/hooks/use-mount-effect.js";
import {
  preloadAutomationViews,
  preloadAutomationViewsWhenIdle,
} from "./automation-views-loader.js";
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
  useMountEffect(preloadAutomationViewsWhenIdle);
  return (
    <PopoverRoot>
      <PopoverTrigger
        className={triggerClassName}
        aria-label={triggerLabel}
        title={triggerLabel}
        onPointerEnter={preloadAutomationViews}
        onPointerDown={preloadAutomationViews}
        onFocus={preloadAutomationViews}
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
