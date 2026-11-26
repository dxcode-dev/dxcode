import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import * as React from "react";
import { cn } from "../utils.js";
import "./tooltip.css";

type PositionerProps = React.ComponentProps<typeof BaseTooltip.Positioner>;

/**
 * dx's tooltip: a short explanation that shows while the pointer rests on,
 * or the keyboard focuses, its trigger, such as what a column counts. It
 * draws in a portal over every pane, so a card's clipping never hides it.
 * `children` is the trigger: one element that can take focus. Screen
 * readers hear `content` as the trigger's description. For a card that
 * people interact with, use the Popover.
 */
export function Tooltip({
  content,
  children,
  side = "top",
  align = "center",
  delay = 300,
}: {
  /** Plain text, at most a sentence or two. */
  readonly content: string;
  /** The trigger: a button, or a span with `tabIndex={0}`. */
  readonly children: React.ReactElement<Record<string, unknown>>;
  readonly side?: PositionerProps["side"];
  readonly align?: PositionerProps["align"];
  /** Milliseconds the pointer rests before it shows. */
  readonly delay?: number;
}) {
  const id = React.useId();
  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger
        delay={delay}
        render={children}
        aria-describedby={id}
      />
      <span id={id} hidden>
        {content}
      </span>
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner
          className="dx-tooltip-positioner"
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={8}
        >
          <BaseTooltip.Popup className="dx-tooltip" role="tooltip">
            {content}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}

/**
 * A tooltip the caller opens and points at an element, such as a chart's
 * hovered column. It has no trigger of its own: the caller shows it while
 * `open` and moves it by changing `anchor`. Like `Tooltip`, it draws over
 * every pane and turns to stay on screen.
 */
export function AnchoredTooltip({
  open,
  anchor,
  side = "top",
  align = "center",
  className,
  children,
}: {
  readonly open: boolean;
  readonly anchor: Element | null;
  readonly side?: PositionerProps["side"];
  readonly align?: PositionerProps["align"];
  readonly className?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <BaseTooltip.Root open={open && anchor !== null}>
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner
          className="dx-tooltip-positioner"
          anchor={anchor}
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={8}
        >
          <BaseTooltip.Popup
            className={cn("dx-tooltip", className)}
            role="tooltip"
          >
            {children}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}

/**
 * Text that explains itself in a tooltip, such as a column header or a
 * stat's label: a dotted underline marks it, and it takes focus so the
 * keyboard reaches the hint. `focusable={false}` inside a link or button,
 * which takes the focus itself.
 */
export function TooltipHint({
  hint,
  focusable = true,
  children,
}: {
  readonly hint: string;
  readonly focusable?: boolean;
  readonly children: React.ReactNode;
}) {
  return (
    <Tooltip content={hint}>
      {focusable ? (
        <button type="button" className="dx-tooltip-hint">
          {children}
        </button>
      ) : (
        <span className="dx-tooltip-hint">{children}</span>
      )}
    </Tooltip>
  );
}
