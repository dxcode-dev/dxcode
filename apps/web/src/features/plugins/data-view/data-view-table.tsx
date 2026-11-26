import {
  type DataViewFormat,
  type DataViewPart,
  readStatePath,
} from "@dx/domain";
import * as React from "react";
import { Badge } from "../../../shared/ui/badge.js";
import { Button } from "../../../shared/ui/button.js";
import { Card } from "../../../shared/ui/card.js";
import { DataTable } from "../../../shared/ui/data-table.js";
import { formatViewValue } from "./data-view-format.js";

import {
  actionLabel,
  keyOf,
  listOf,
  type PartContext,
  recordOf,
  text,
  toneOf,
} from "./data-view-values.js";

/**
 * A view's table, sortable by any column, with an action per row: a
 * click anywhere in the row runs it, and its button (named by the action's
 * `label`) does the same for the keyboard and screen readers.
 */

const VIRTUAL_ROWS = 50;

export function TablePart({
  id,
  part,
  context,
}: {
  readonly id: string;
  readonly part: DataViewPart & { readonly type: "table" };
  readonly context: PartContext;
}) {
  const rows = listOf(readStatePath(context.state, part.bind));
  const [sort, setSort] = React.useState<{
    readonly columnId: string;
    readonly direction: "asc" | "desc";
  }>();
  const sorted =
    sort === undefined
      ? rows
      : rows.toSorted((left, right) => {
          const a = recordOf(left)[sort.columnId];
          const b = recordOf(right)[sort.columnId];
          const order =
            typeof a === "number" && typeof b === "number"
              ? a - b
              : text(a).localeCompare(text(b), undefined, { numeric: true });
          return sort.direction === "asc" ? order : -order;
        });
  const action = part.rowAction;
  const runRow = (row: unknown) => {
    if (action === undefined) return;
    void context.run(
      `${id}.${keyOf(row, part.rowKey, rows.indexOf(row))}`,
      action,
      { state: context.state, row },
    );
  };
  return (
    <Card padding="none" className="data-view-card">
      <DataTable
        label={part.label ?? "Rows"}
        rows={sorted}
        rowKey={(row) => keyOf(row, part.rowKey, rows.indexOf(row))}
        columns={[
          ...part.columns.map((column) => ({
            id: column.key,
            header: column.label,
            ...(column.hint === undefined ? {} : { hint: column.hint }),
            sortable: true,
            numeric:
              column.format !== undefined &&
              column.format !== "text" &&
              column.format !== "time",
            ...(column.secondary === true ? { secondary: true } : {}),
            cell: (row: unknown) => {
              const value = recordOf(row)[column.key];
              return column.tones === undefined ? (
                formatViewValue(value, column.format)
              ) : (
                <Badge tone={toneOf(value, column.tones)}>{text(value)}</Badge>
              );
            },
          })),
          ...(action === undefined
            ? []
            : [
                {
                  id: "__action",
                  header: <span className="visually-hidden">Action</span>,
                  cell: (row: unknown) => {
                    const rowId = `${id}.${keyOf(row, part.rowKey, rows.indexOf(row))}`;
                    return (
                      <Button
                        aria-label={`${actionLabel(action)}: ${rowName(row, part.columns)}`}
                        variant="ghost"
                        size="xs"
                        busy={context.busy === rowId}
                        aria-disabled={
                          context.disabledReason !== undefined || undefined
                        }
                        title={context.disabledReason}
                        onClick={() => runRow(row)}
                      >
                        {actionLabel(action)}
                      </Button>
                    );
                  },
                },
              ]),
        ]}
        {...(sort === undefined ? {} : { sort })}
        onSortChange={setSort}
        {...(action === undefined ? {} : { onRowClick: runRow })}
        {...(rows.length > VIRTUAL_ROWS ? { maxHeight: 480 } : {})}
        empty={part.empty ?? "No rows yet."}
      />
    </Card>
  );
}

/** A row's name for its action button: its first two columns' text. */
const rowName = (
  row: unknown,
  columns: ReadonlyArray<{
    readonly key: string;
    readonly format?: DataViewFormat;
  }>,
) =>
  columns
    .slice(0, 2)
    .flatMap((column) => {
      const value = formatViewValue(recordOf(row)[column.key], column.format);
      return value === "" ? [] : [value];
    })
    .join(", ");
