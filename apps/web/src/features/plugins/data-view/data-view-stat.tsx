import { type DataViewPart, readStatePath } from "@dx/domain";
import { Button } from "../../../shared/ui/button.js";
import { StatTile } from "../../../shared/ui/stat-tile.js";
import { formatViewValue, numberOf } from "./data-view-format.js";

import type { PartContext } from "./data-view-values.js";

/** A stat in a view's figures grid, and a button in its row of buttons. */

export function StatPart({
  part,
  state,
}: {
  readonly part: DataViewPart & { readonly type: "stat" };
  readonly state: unknown;
}) {
  const value = readStatePath(state, part.bind);
  const change =
    part.change === undefined
      ? undefined
      : numberOf(readStatePath(state, part.change));
  const good = part.rising !== "bad";
  return (
    <StatTile
      label={part.label}
      {...(part.hint === undefined ? {} : { hint: part.hint })}
      value={
        value === undefined
          ? undefined
          : formatViewValue(value, part.format ?? "number")
      }
      {...(part.detail === undefined ? {} : { detail: part.detail })}
      {...(change === undefined
        ? {}
        : {
            change: {
              label: formatViewValue(Math.abs(change), part.format ?? "number"),
              direction: change > 0 ? "up" : change < 0 ? "down" : "flat",
              tone:
                change === 0
                  ? "neutral"
                  : change > 0 === good
                    ? "positive"
                    : "negative",
            },
          })}
    />
  );
}

export function ButtonPart({
  id,
  part,
  context,
}: {
  readonly id: string;
  readonly part: DataViewPart & { readonly type: "button" };
  readonly context: PartContext;
}) {
  const disabled = context.disabledReason !== undefined;
  return (
    <Button
      variant={
        part.variant === "danger" ? "destructive" : (part.variant ?? "default")
      }
      size="sm"
      busy={context.busy === id}
      aria-disabled={disabled || undefined}
      title={context.disabledReason}
      onClick={() =>
        void context.run(id, part.action, { state: context.state })
      }
    >
      {part.label}
    </Button>
  );
}
