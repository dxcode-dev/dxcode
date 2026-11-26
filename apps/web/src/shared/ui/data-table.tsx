import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import type * as React from "react";
import { useState } from "react";
import { useVirtualRows } from "../hooks/use-virtual-rows.js";
import { cn } from "../utils.js";
import { Button } from "./button.js";
import { Checkbox } from "./checkbox.js";
import { EmptyState } from "./empty-state.js";
import "./data-table.css";

export type DataTableSortDirection = "asc" | "desc";

/** The column a table is sorted by, and which way. */
export interface DataTableSort {
  readonly columnId: string;
  readonly direction: DataTableSortDirection;
}

export interface DataTableColumn<Row> {
  readonly id: string;
  readonly header: React.ReactNode;
  readonly cell: (row: Row) => React.ReactNode;
  /** Right-aligned with tabular figures, for amounts, counts, and dates. */
  readonly numeric?: boolean;
  /** The header becomes a button that asks for this sort. */
  readonly sortable?: boolean;
  /** The direction a first click asks for; numbers usually start high. */
  readonly firstDirection?: DataTableSortDirection;
  /** Hidden on phones (under 640px), for detail the row can do without. */
  readonly secondary?: boolean;
  /** A CSS width such as `40%` or `8rem`. */
  readonly width?: string;
}

/** Keyset pagination: the server hands out the next page on request. */
export interface DataTablePagination {
  readonly hasMore: boolean;
  readonly loadingMore?: boolean;
  readonly onLoadMore: () => void;
  /** Left of the button, such as "50 people". */
  readonly summary?: React.ReactNode;
}

/** Row selection, keyed by `rowKey`, for actions on many rows at once. */
export interface DataTableSelection {
  readonly selected: ReadonlySet<string>;
  readonly onSelectedChange: (selected: ReadonlySet<string>) => void;
  /** Names a row for its checkbox: "Select ada@example.com". */
  readonly rowLabel: (key: string) => string;
}

const nextSort = (
  sort: DataTableSort | undefined,
  column: DataTableColumn<never>,
): DataTableSort =>
  sort?.columnId === column.id
    ? {
        columnId: column.id,
        direction: sort.direction === "asc" ? "desc" : "asc",
      }
    : { columnId: column.id, direction: column.firstDirection ?? "asc" };

const ariaSort = (
  sort: DataTableSort | undefined,
  column: DataTableColumn<never>,
) =>
  sort?.columnId !== column.id
    ? column.sortable
      ? ("none" as const)
      : undefined
    : sort.direction === "asc"
      ? ("ascending" as const)
      : ("descending" as const);

/** A first guess at a row's height in px; virtual rows measure themselves. */
const ESTIMATED_ROW_HEIGHT = 33;

/** Holds the height of the rows above or below the drawn ones. */
function SpacerRow({
  span,
  height,
}: {
  readonly span: number;
  readonly height: number;
}) {
  return height <= 0 ? null : (
    <tr className="dx-data-table-spacer">
      <td aria-hidden="true" colSpan={span} style={{ height }} />
    </tr>
  );
}

function SortIcon({
  direction,
}: {
  readonly direction?: DataTableSortDirection;
}) {
  return direction === "asc" ? (
    <ArrowUp aria-hidden="true" />
  ) : direction === "desc" ? (
    <ArrowDown aria-hidden="true" />
  ) : (
    <ChevronsUpDown aria-hidden="true" data-idle="" />
  );
}

/**
 * Rows of records with column headers, for admin lists such as people,
 * coupons, or Orbs. Sorting is controlled: a sortable header asks for a
 * sort through `onSortChange`, and the caller sorts or refetches. The
 * footer loads the next keyset page. `rows` undefined shows loading;
 * `error` replaces the rows with a retry. `maxHeight` scrolls the rows
 * under a sticky header and draws only those in view, for thousands of rows.
 */
export function DataTable<Row>({
  label,
  columns,
  rows,
  rowKey,
  sort,
  onSortChange,
  selection,
  pagination,
  empty,
  error,
  onRetry,
  maxHeight,
  className,
}: {
  /** Names the table for assistive tech: "People". */
  readonly label: string;
  readonly columns: ReadonlyArray<DataTableColumn<Row>>;
  readonly rows: ReadonlyArray<Row> | undefined;
  readonly rowKey: (row: Row) => string;
  readonly sort?: DataTableSort;
  readonly onSortChange?: (sort: DataTableSort) => void;
  readonly selection?: DataTableSelection;
  readonly pagination?: DataTablePagination;
  /** What an empty table says: "No one is waiting." */
  readonly empty?: React.ReactNode;
  /** A load failure, shown instead of the rows. */
  readonly error?: React.ReactNode;
  readonly onRetry?: () => void;
  /**
   * Caps the table at this many px: the rows scroll under a sticky header,
   * and only the rows in view are drawn.
   */
  readonly maxHeight?: number;
  readonly className?: string;
}) {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const virtual = maxHeight !== undefined;
  const windowed = useVirtualRows({
    scrollElement: virtual ? scroller : null,
    count: virtual && error === undefined ? (rows?.length ?? 0) : 0,
    rowHeight: ESTIMATED_ROW_HEIGHT,
    overscan: 10,
  });
  const keys = (rows ?? []).map(rowKey);
  const selectedCount =
    selection === undefined
      ? 0
      : keys.filter((key) => selection.selected.has(key)).length;
  const allSelected = keys.length > 0 && selectedCount === keys.length;
  const toggleAll = () => {
    if (selection === undefined) return;
    const next = new Set(selection.selected);
    for (const key of keys) {
      if (allSelected) next.delete(key);
      else next.add(key);
    }
    selection.onSelectedChange(next);
  };
  const toggle = (key: string) => {
    if (selection === undefined) return;
    const next = new Set(selection.selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    selection.onSelectedChange(next);
  };
  const span = columns.length + (selection === undefined ? 0 : 1);
  // `index` is set only when virtual: the row then reports its position
  // (after the header row) and is measured, since only some rows exist.
  const renderRow = (row: Row, index?: number) => {
    const key = rowKey(row);
    const selected = selection?.selected.has(key) ?? false;
    return (
      <tr
        key={key}
        data-selected={selected || undefined}
        data-index={index}
        aria-rowindex={index === undefined ? undefined : index + 2}
        ref={index === undefined ? undefined : windowed.measure}
      >
        {selection === undefined ? null : (
          <td className="dx-data-table-select">
            <Checkbox
              aria-label={selection.rowLabel(key)}
              checked={selected}
              onChange={() => toggle(key)}
            />
          </td>
        )}
        {columns.map((column) => (
          <td
            key={column.id}
            data-numeric={column.numeric || undefined}
            data-secondary={column.secondary || undefined}
          >
            {column.cell(row)}
          </td>
        ))}
      </tr>
    );
  };
  return (
    <div
      className={cn("dx-data-table", className)}
      data-virtual={virtual || undefined}
    >
      <div
        className="dx-data-table-scroll"
        ref={virtual ? setScroller : undefined}
        style={virtual ? { maxHeight } : undefined}
        tabIndex={virtual ? 0 : undefined}
      >
        <table
          aria-label={label}
          aria-busy={rows === undefined || undefined}
          aria-rowcount={
            virtual && rows !== undefined ? rows.length + 1 : undefined
          }
        >
          <colgroup>
            {selection === undefined ? null : (
              <col className="dx-data-table-select-col" />
            )}
            {columns.map((column) => (
              <col
                key={column.id}
                data-secondary={column.secondary || undefined}
                style={
                  column.width === undefined
                    ? undefined
                    : { width: column.width }
                }
              />
            ))}
          </colgroup>
          <thead>
            <tr aria-rowindex={virtual ? 1 : undefined}>
              {selection === undefined ? null : (
                <th className="dx-data-table-select">
                  <Checkbox
                    aria-label="Select all rows"
                    checked={allSelected}
                    disabled={keys.length === 0}
                    ref={(box) => {
                      if (box !== null)
                        box.indeterminate = selectedCount > 0 && !allSelected;
                    }}
                    onChange={toggleAll}
                  />
                </th>
              )}
              {columns.map((column) => (
                <th
                  key={column.id}
                  scope="col"
                  aria-sort={ariaSort(sort, column as DataTableColumn<never>)}
                  data-numeric={column.numeric || undefined}
                  data-secondary={column.secondary || undefined}
                >
                  {column.sortable && onSortChange !== undefined ? (
                    <button
                      type="button"
                      className="dx-data-table-sort"
                      data-active={sort?.columnId === column.id || undefined}
                      onClick={() =>
                        onSortChange(
                          nextSort(sort, column as DataTableColumn<never>),
                        )
                      }
                    >
                      {column.header}
                      <SortIcon
                        direction={
                          sort?.columnId === column.id
                            ? sort.direction
                            : undefined
                        }
                      />
                    </button>
                  ) : (
                    column.header
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {error !== undefined ? (
              <tr className="dx-data-table-state">
                <td colSpan={span}>
                  <EmptyState
                    tone="error"
                    title={error}
                    action={
                      onRetry === undefined ? undefined : (
                        <Button size="sm" variant="outline" onClick={onRetry}>
                          Retry
                        </Button>
                      )
                    }
                  />
                </td>
              </tr>
            ) : rows === undefined ? (
              ["one", "two", "three"].map((placeholder) => (
                <tr key={placeholder} className="dx-data-table-loading">
                  {selection === undefined ? null : <td />}
                  {columns.map((column) => (
                    <td
                      key={column.id}
                      data-numeric={column.numeric || undefined}
                      data-secondary={column.secondary || undefined}
                    >
                      <span className="dx-data-table-placeholder" />
                    </td>
                  ))}
                </tr>
              ))
            ) : rows.length === 0 ? (
              <tr className="dx-data-table-state">
                <td colSpan={span}>
                  <EmptyState title={empty ?? "Nothing here yet."} />
                </td>
              </tr>
            ) : virtual ? (
              <>
                <SpacerRow span={span} height={windowed.rows[0]?.start ?? 0} />
                {windowed.rows.map(({ index }) => {
                  const row = rows[index];
                  return row === undefined ? null : renderRow(row, index);
                })}
                <SpacerRow
                  span={span}
                  height={windowed.totalSize - (windowed.rows.at(-1)?.end ?? 0)}
                />
              </>
            ) : (
              rows.map((row) => renderRow(row))
            )}
          </tbody>
        </table>
      </div>
      {pagination === undefined ||
      error !== undefined ||
      rows === undefined ||
      (rows.length === 0 && !pagination.hasMore) ? null : (
        <footer className="dx-data-table-footer">
          <span>{pagination.summary}</span>
          {pagination.hasMore ? (
            <Button
              size="sm"
              variant="outline"
              busy={pagination.loadingMore}
              disabled={pagination.loadingMore}
              onClick={pagination.onLoadMore}
            >
              {pagination.loadingMore ? "Loading…" : "Load more"}
            </Button>
          ) : null}
        </footer>
      )}
    </div>
  );
}
