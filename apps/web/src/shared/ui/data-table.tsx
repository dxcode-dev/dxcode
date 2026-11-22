import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import type * as React from "react";
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
 * `error` replaces the rows with a retry.
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
  readonly className?: string;
}) {
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
  return (
    <div className={cn("dx-data-table", className)}>
      <div className="dx-data-table-scroll">
        <table aria-label={label} aria-busy={rows === undefined || undefined}>
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
            <tr>
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
            ) : (
              rows.map((row) => {
                const key = rowKey(row);
                const selected = selection?.selected.has(key) ?? false;
                return (
                  <tr key={key} data-selected={selected || undefined}>
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
              })
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
