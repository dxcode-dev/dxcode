import { Select as BaseSelect } from "@base-ui/react/select";
import { Check, ChevronDown, Search } from "lucide-react";
import type * as React from "react";
import { cn } from "../utils.js";
import "./picker.css";

/**
 * A choice list rendered by dx instead of the browser, for options that
 * need a mark, a second line, groups, or a search row, such as the Project
 * and mode pickers. A plain list of labels uses the native `Select`. The
 * list shares the menu's surface and rows.
 */
export const ChoiceSelectRoot = BaseSelect.Root;
export const ChoiceSelectValue = BaseSelect.Value;
export const ChoiceSelectItemText = BaseSelect.ItemText;

/**
 * The button that opens the list. `variant="field"` (default) looks like
 * the native Select and ends in a chevron; `variant="bare"` adds no look,
 * for a trigger styled as a pill or a Button.
 */
export function ChoiceSelectTrigger({
  className,
  variant = "field",
  size = "md",
  children,
  ...props
}: React.ComponentProps<typeof BaseSelect.Trigger> & {
  readonly variant?: "field" | "bare";
  readonly size?: "sm" | "md" | "lg";
}) {
  return (
    <BaseSelect.Trigger
      className={cn(variant === "field" && "dx-picker-trigger", className)}
      data-size={variant === "field" ? size : undefined}
      {...props}
    >
      {children}
      {variant === "field" ? <ChevronDown aria-hidden="true" /> : null}
    </BaseSelect.Trigger>
  );
}

type PositionerProps = React.ComponentProps<typeof BaseSelect.Positioner>;

/** The list's surface, below its trigger. */
export function ChoiceSelectPopup({
  children,
  className,
  positionerClassName,
  width,
  side = "bottom",
  align = "start",
  sideOffset = 4,
  collisionPadding = 8,
  finalFocus,
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
  /**
   * Where focus goes when the list closes; the trigger by default. Gets how
   * it closed (`keyboard`, `mouse`, `touch`).
   */
  readonly finalFocus?: React.ComponentProps<
    typeof BaseSelect.Popup
  >["finalFocus"];
  readonly "aria-label"?: string;
}) {
  return (
    <BaseSelect.Portal>
      <BaseSelect.Positioner
        className={cn("dx-picker-positioner", positionerClassName)}
        side={side}
        align={align}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        alignItemWithTrigger={false}
      >
        <BaseSelect.Popup
          className={cn("dx-picker", className)}
          data-width={width}
          aria-label={ariaLabel}
          {...(finalFocus === undefined ? {} : { finalFocus })}
        >
          {children}
        </BaseSelect.Popup>
      </BaseSelect.Positioner>
    </BaseSelect.Portal>
  );
}

export function ChoiceSelectList({
  className,
  ...props
}: React.ComponentProps<typeof BaseSelect.List>) {
  return (
    <BaseSelect.List className={cn("dx-picker-list", className)} {...props} />
  );
}

/**
 * One choice. A chosen item ends in a check; pass `check={false}` for an
 * item that acts instead of choosing, such as "New Project".
 */
export function ChoiceSelectItem({
  className,
  check = true,
  children,
  ...props
}: React.ComponentProps<typeof BaseSelect.Item> & {
  readonly check?: boolean;
}) {
  return (
    <BaseSelect.Item className={cn("dx-picker-item", className)} {...props}>
      {children}
      {check ? (
        <BaseSelect.ItemIndicator className="dx-picker-check">
          <Check aria-hidden="true" />
        </BaseSelect.ItemIndicator>
      ) : null}
    </BaseSelect.Item>
  );
}

/**
 * An item's two lines: its name, and a quieter detail under it, such as who
 * pays for a model. `trailing` sits at the name's end, such as an effort.
 */
export function ChoiceSelectItemDetail({
  title,
  detail,
  trailing,
  icon,
}: {
  readonly title: React.ReactNode;
  readonly detail?: React.ReactNode;
  readonly trailing?: React.ReactNode;
  readonly icon?: React.ReactNode;
}) {
  return (
    <span className="dx-picker-item-detail">
      {icon === undefined ? null : (
        <span className="dx-picker-item-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <span className="dx-picker-item-lines">
        <span className="dx-picker-item-title">
          <BaseSelect.ItemText className="dx-picker-item-label">
            {title}
          </BaseSelect.ItemText>
          {trailing === undefined ? null : (
            <span className="dx-picker-item-trailing">{trailing}</span>
          )}
        </span>
        {detail === undefined ? null : (
          <span className="dx-picker-item-note">{detail}</span>
        )}
      </span>
    </span>
  );
}

/**
 * A row under the list for a setting of the chosen item, such as its effort.
 * Pointer and keys inside it stay out of the list's navigation.
 */
export function ChoiceSelectFooter({
  children,
  label,
}: {
  readonly children: React.ReactNode;
  readonly label?: React.ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: keeps the list's typeahead out of the footer's controls.
    <div
      className="dx-picker-footer"
      onKeyDown={(event) => {
        if (event.key !== "Escape") event.stopPropagation();
      }}
    >
      {label === undefined ? null : (
        <span className="dx-picker-footer-label">{label}</span>
      )}
      {children}
    </div>
  );
}

export function ChoiceSelectSeparator() {
  return <BaseSelect.Separator className="dx-picker-separator" />;
}

/** A small heading over a run of items. */
export function ChoiceSelectLabel({
  children,
}: {
  readonly children: React.ReactNode;
}) {
  return <div className="dx-picker-label">{children}</div>;
}

/** What the list says when nothing matches. */
export function ChoiceSelectEmpty({
  children,
}: {
  readonly children: React.ReactNode;
}) {
  return (
    <div
      role="option"
      aria-disabled="true"
      aria-selected="false"
      tabIndex={-1}
      className="dx-picker-empty"
    >
      {children}
    </div>
  );
}

/**
 * A search row at the top of the popup. The caller filters the items; keys
 * other than Escape stay in the field instead of moving through the list.
 */
export function ChoiceSelectSearch({
  trailing,
  onKeyDown,
  ...props
}: Omit<React.ComponentProps<"input">, "type"> & {
  /** Shown at the row's end, such as the picker's shortcut. */
  readonly trailing?: React.ReactNode;
}) {
  return (
    <label className="dx-picker-search">
      <Search aria-hidden="true" />
      <input
        type="search"
        onKeyDown={(event) => {
          if (event.key !== "Escape") event.stopPropagation();
          onKeyDown?.(event);
        }}
        {...props}
      />
      {trailing}
    </label>
  );
}

/** One choice of a `ChoiceSelect`. */
export interface ChoiceOption {
  readonly value: string;
  readonly label: string;
  /** A mark before the label, such as a provider's, in the list and the field. */
  readonly icon?: React.ReactNode;
  /** A quieter line under the label, in the list only. */
  readonly detail?: React.ReactNode;
}

/**
 * A choice list with one look everywhere: the field's chevron, the menu's
 * rows, and a check on the chosen one. Use it beside pickers and searchable
 * fields so every dropdown in a form reads the same; give it `options`, or
 * compose the parts above for anything else.
 */
export function ChoiceSelect({
  id,
  options,
  value,
  onValueChange,
  size = "md",
  disabled,
  placeholder,
  className,
  "aria-label": ariaLabel,
}: {
  readonly id?: string;
  readonly options: ReadonlyArray<ChoiceOption>;
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly size?: "sm" | "md" | "lg";
  readonly disabled?: boolean;
  /** Shown when `value` names no option. */
  readonly placeholder?: string;
  readonly className?: string;
  readonly "aria-label"?: string;
}) {
  const current = options.find((option) => option.value === value);
  return (
    <ChoiceSelectRoot
      value={value}
      items={options.map(({ value: item, label }) => ({ value: item, label }))}
      onValueChange={(next) => {
        if (typeof next === "string") onValueChange(next);
      }}
      {...(disabled === undefined ? {} : { disabled })}
    >
      <ChoiceSelectTrigger
        id={id}
        size={size}
        className={cn("dx-choice-trigger", className)}
        {...(ariaLabel === undefined ? {} : { "aria-label": ariaLabel })}
      >
        {current?.icon === undefined ? null : (
          <span className="dx-choice-icon" aria-hidden="true">
            {current.icon}
          </span>
        )}
        <span data-placeholder={current === undefined ? "" : undefined}>
          {current?.label ?? placeholder ?? ""}
        </span>
      </ChoiceSelectTrigger>
      <ChoiceSelectPopup width="anchor">
        <ChoiceSelectList>
          {options.map((option) => (
            <ChoiceSelectItem
              key={option.value}
              value={option.value}
              label={option.label}
            >
              {option.icon === undefined && option.detail === undefined ? (
                <ChoiceSelectItemText className="dx-picker-item-label">
                  {option.label}
                </ChoiceSelectItemText>
              ) : (
                <ChoiceSelectItemDetail
                  title={option.label}
                  {...(option.detail === undefined
                    ? {}
                    : { detail: option.detail })}
                  {...(option.icon === undefined ? {} : { icon: option.icon })}
                />
              )}
            </ChoiceSelectItem>
          ))}
        </ChoiceSelectList>
      </ChoiceSelectPopup>
    </ChoiceSelectRoot>
  );
}
