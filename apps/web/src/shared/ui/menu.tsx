import { ContextMenu } from "@base-ui/react/context-menu";
import { Menu as BaseMenu } from "@base-ui/react/menu";
import { Check, ChevronRight } from "lucide-react";
import type * as React from "react";
import { cn } from "../utils.js";
import "./menu.css";

/**
 * dx's one menu. Every dropdown, submenu, and right-click menu renders from
 * these parts, so they share one look: a popover surface, 30px rows, a muted
 * 15px leading icon, and a trailing chevron or check. Build the trigger with
 * `MenuTrigger` (or `ContextMenuTrigger`) and put `MenuItem`s in a
 * `MenuPopup`. See the Menu stories in Storybook.
 */
export const MenuRoot = BaseMenu.Root;
export const MenuTrigger = BaseMenu.Trigger;
export const MenuGroup = BaseMenu.Group;
export const MenuRadioGroup = BaseMenu.RadioGroup;
export const MenuSubmenuRoot = BaseMenu.SubmenuRoot;
export const ContextMenuRoot = ContextMenu.Root;
export const ContextMenuTrigger = ContextMenu.Trigger;

type PositionerProps = React.ComponentProps<typeof BaseMenu.Positioner>;

/** The menu's surface, portalled and positioned beside its trigger. */
export function MenuPopup({
  children,
  className,
  positionerClassName,
  side,
  align,
  sideOffset = 4,
  alignOffset,
  anchor,
  collisionPadding,
  "aria-label": ariaLabel,
  finalFocus,
  onKeyDown,
}: {
  readonly children: React.ReactNode;
  readonly className?: string;
  readonly positionerClassName?: string;
  readonly side?: PositionerProps["side"];
  readonly align?: PositionerProps["align"];
  readonly sideOffset?: PositionerProps["sideOffset"];
  readonly alignOffset?: PositionerProps["alignOffset"];
  readonly anchor?: PositionerProps["anchor"];
  readonly collisionPadding?: PositionerProps["collisionPadding"];
  readonly "aria-label"?: string;
  readonly finalFocus?: React.ComponentProps<
    typeof BaseMenu.Popup
  >["finalFocus"];
  readonly onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
}) {
  return (
    <BaseMenu.Portal>
      <BaseMenu.Positioner
        className={cn("dx-menu-positioner", positionerClassName)}
        side={side}
        align={align}
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        anchor={anchor}
        collisionPadding={collisionPadding}
      >
        <BaseMenu.Popup
          className={cn("dx-menu", className)}
          aria-label={ariaLabel}
          finalFocus={finalFocus}
          onKeyDown={onKeyDown}
        >
          {children}
        </BaseMenu.Popup>
      </BaseMenu.Positioner>
    </BaseMenu.Portal>
  );
}

type Tone = { readonly tone?: "danger" };

export function MenuItem({
  className,
  tone,
  ...props
}: React.ComponentProps<typeof BaseMenu.Item> & Tone) {
  return (
    <BaseMenu.Item
      className={cn("dx-menu-item", className)}
      data-tone={tone}
      {...props}
    />
  );
}

/** An item that opens a submenu; it ends in a chevron. */
export function MenuSubmenuTrigger({
  className,
  tone,
  children,
  ...props
}: React.ComponentProps<typeof BaseMenu.SubmenuTrigger> & Tone) {
  return (
    <BaseMenu.SubmenuTrigger
      className={cn("dx-menu-item", className)}
      data-tone={tone}
      {...props}
    >
      {children}
      <ChevronRight data-trailing />
    </BaseMenu.SubmenuTrigger>
  );
}

/** One choice of a `MenuRadioGroup`; the chosen one shows a check. */
export function MenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof BaseMenu.RadioItem>) {
  return (
    <BaseMenu.RadioItem className={cn("dx-menu-item", className)} {...props}>
      {children}
      <BaseMenu.RadioItemIndicator className="dx-menu-check" keepMounted>
        <Check />
      </BaseMenu.RadioItemIndicator>
    </BaseMenu.RadioItem>
  );
}

/** An on/off item; when on it shows a check. */
export function MenuCheckboxItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof BaseMenu.CheckboxItem>) {
  return (
    <BaseMenu.CheckboxItem className={cn("dx-menu-item", className)} {...props}>
      {children}
      <BaseMenu.CheckboxItemIndicator className="dx-menu-check" keepMounted>
        <Check />
      </BaseMenu.CheckboxItemIndicator>
    </BaseMenu.CheckboxItem>
  );
}

export function MenuSeparator({ className }: { readonly className?: string }) {
  return <BaseMenu.Separator className={cn("dx-menu-separator", className)} />;
}

/** A small heading over a `MenuGroup`'s items. */
export function MenuLabel({
  className,
  ...props
}: React.ComponentProps<typeof BaseMenu.GroupLabel>) {
  return (
    <BaseMenu.GroupLabel
      className={cn("dx-menu-label", className)}
      {...props}
    />
  );
}

/** A value after an item's label, such as a cost or a shortcut. */
export function MenuItemHint({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return <span className={cn("dx-menu-hint", className)} {...props} />;
}

/**
 * An item's title with its description under it. The item grows to fit both
 * lines, and a long description wraps inside the menu.
 */
export function MenuItemText({
  title,
  description,
}: {
  readonly title: React.ReactNode;
  readonly description: React.ReactNode;
}) {
  return (
    <span className="menu-item-text">
      <span className="menu-item-title">{title}</span>
      <span className="menu-item-description">{description}</span>
    </span>
  );
}
