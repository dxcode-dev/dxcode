import { Popover as BasePopover } from "@base-ui/react/popover";
import type * as React from "react";
import { cn } from "../utils.js";
import "./overlay.css";

/**
 * dx's popover: a floating card beside its trigger for details or a small
 * form, such as a person's card or a model's details. For a list of actions
 * use the Menu; for a task that needs the page's attention use a Dialog.
 */
export const PopoverRoot = BasePopover.Root;
export const PopoverTrigger = BasePopover.Trigger;
export const PopoverTitle = BasePopover.Title;

type PositionerProps = React.ComponentProps<typeof BasePopover.Positioner>;
type PopupProps = React.ComponentProps<typeof BasePopover.Popup>;

export function PopoverContent({
  children,
  className,
  positionerClassName,
  side,
  align,
  sideOffset = 6,
  alignOffset,
  collisionPadding = 8,
  positionMethod,
  anchor,
  initialFocus,
  finalFocus,
  "aria-label": ariaLabel,
}: {
  readonly children: React.ReactNode;
  readonly className?: string;
  readonly positionerClassName?: string;
  readonly side?: PositionerProps["side"];
  readonly align?: PositionerProps["align"];
  readonly sideOffset?: PositionerProps["sideOffset"];
  readonly alignOffset?: PositionerProps["alignOffset"];
  readonly collisionPadding?: PositionerProps["collisionPadding"];
  readonly positionMethod?: PositionerProps["positionMethod"];
  readonly anchor?: PositionerProps["anchor"];
  readonly initialFocus?: PopupProps["initialFocus"];
  readonly finalFocus?: PopupProps["finalFocus"];
  readonly "aria-label"?: string;
}) {
  return (
    <BasePopover.Portal>
      <BasePopover.Positioner
        className={cn("dx-popover-positioner", positionerClassName)}
        side={side}
        align={align}
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        collisionPadding={collisionPadding}
        positionMethod={positionMethod}
        anchor={anchor}
      >
        <BasePopover.Popup
          className={cn("dx-popover", className)}
          initialFocus={initialFocus}
          finalFocus={finalFocus}
          aria-label={ariaLabel}
        >
          {children}
        </BasePopover.Popup>
      </BasePopover.Positioner>
    </BasePopover.Portal>
  );
}
