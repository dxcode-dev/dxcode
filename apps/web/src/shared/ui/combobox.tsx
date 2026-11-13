import { Combobox as BaseCombobox } from "@base-ui/react/combobox";
import { Check, ChevronDown, Search } from "lucide-react";
import type * as React from "react";
import { cn } from "../utils.js";
import "./picker.css";

/**
 * dx's searchable picker. Two shapes:
 * - a typed field: `ComboboxField` holds the `ComboboxInput` and a list
 *   toggle, as in a repository URL field;
 * - a button: `ComboboxTrigger` looks like the native Select, and the
 *   popup's `ComboboxSearch` filters the list.
 * The list (`ComboboxPopup`, `ComboboxList`, `ComboboxItem`) shares the
 * menu's surface and rows. For a short fixed list use `Select`; for one
 * whose options need marks or two lines use `ChoiceSelect`.
 */
export const ComboboxRoot = BaseCombobox.Root;
export const ComboboxValue = BaseCombobox.Value;

type Size = "sm" | "md" | "lg";

/** A typed field with a list toggle; put a `ComboboxInput` in it. */
export function ComboboxField({
  className,
  size = "md",
  toggleLabel = "Open list",
  children,
}: {
  readonly className?: string;
  readonly size?: Size;
  readonly toggleLabel?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <BaseCombobox.InputGroup
      className={cn("dx-combobox-field", className)}
      data-size={size}
    >
      {children}
      <BaseCombobox.Trigger
        className="dx-combobox-toggle"
        aria-label={toggleLabel}
      >
        <ChevronDown aria-hidden="true" />
      </BaseCombobox.Trigger>
    </BaseCombobox.InputGroup>
  );
}

export const ComboboxInput = BaseCombobox.Input;

/**
 * The button that opens the list. `variant="field"` (default) looks like
 * the native Select and ends in a chevron; `variant="bare"` adds no look,
 * for a trigger styled as a Button or a pill.
 */
export function ComboboxTrigger({
  className,
  variant = "field",
  size = "md",
  children,
  ...props
}: React.ComponentProps<typeof BaseCombobox.Trigger> & {
  readonly variant?: "field" | "bare";
  readonly size?: Size;
}) {
  return (
    <BaseCombobox.Trigger
      className={cn(variant === "field" && "dx-picker-trigger", className)}
      data-size={variant === "field" ? size : undefined}
      {...props}
    >
      {children}
      {variant === "field" ? <ChevronDown aria-hidden="true" /> : null}
    </BaseCombobox.Trigger>
  );
}

type PositionerProps = React.ComponentProps<typeof BaseCombobox.Positioner>;

/**
 * The list's surface. `width="anchor"` matches the trigger or field;
 * otherwise it is at least that wide.
 */
export function ComboboxPopup({
  children,
  className,
  positionerClassName,
  width,
  side,
  align = "start",
  sideOffset = 4,
  collisionPadding = 8,
  "aria-label": ariaLabel,
}: {
  readonly children: React.ReactNode;
  readonly className?: string;
  readonly positionerClassName?: string;
  readonly width?: "anchor";
  readonly side?: PositionerProps["side"];
  readonly align?: PositionerProps["align"];
  readonly sideOffset?: PositionerProps["sideOffset"];
  readonly collisionPadding?: PositionerProps["collisionPadding"];
  readonly "aria-label"?: string;
}) {
  return (
    <BaseCombobox.Portal>
      <BaseCombobox.Positioner
        className={cn("dx-picker-positioner", positionerClassName)}
        side={side}
        align={align}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
      >
        <BaseCombobox.Popup
          className={cn("dx-picker", className)}
          data-width={width}
          aria-label={ariaLabel}
        >
          {children}
        </BaseCombobox.Popup>
      </BaseCombobox.Positioner>
    </BaseCombobox.Portal>
  );
}

/** A search row at the top of the popup that filters the list. */
export function ComboboxSearch({
  className,
  ...props
}: React.ComponentProps<typeof BaseCombobox.Input>) {
  return (
    <div className="dx-picker-search">
      <Search aria-hidden="true" />
      <BaseCombobox.Input className={className} autoComplete="off" {...props} />
    </div>
  );
}

export function ComboboxList({
  className,
  ...props
}: React.ComponentProps<typeof BaseCombobox.List>) {
  return (
    <BaseCombobox.List className={cn("dx-picker-list", className)} {...props} />
  );
}

/** What the list says when nothing matches or it is loading. */
export function ComboboxEmpty({
  className,
  ...props
}: React.ComponentProps<typeof BaseCombobox.Empty>) {
  return (
    <BaseCombobox.Empty
      className={cn("dx-picker-empty", className)}
      {...props}
    />
  );
}

/**
 * One choice. A chosen item ends in a check; pass `check={false}` when the
 * item draws its own mark, such as a multi-select's checkbox.
 */
export function ComboboxItem({
  className,
  check = true,
  children,
  ...props
}: React.ComponentProps<typeof BaseCombobox.Item> & {
  readonly check?: boolean;
}) {
  return (
    <BaseCombobox.Item className={cn("dx-picker-item", className)} {...props}>
      {children}
      {check ? (
        <BaseCombobox.ItemIndicator className="dx-picker-check">
          <Check aria-hidden="true" />
        </BaseCombobox.ItemIndicator>
      ) : null}
    </BaseCombobox.Item>
  );
}
