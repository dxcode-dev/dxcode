import { Menu } from "@base-ui/react/menu";
import { GripHorizontal, GripVertical, Plus } from "lucide-react";
import type { ArtifactTablePlacement } from "./artifact-session.js";
import type { TableAction } from "./block-commands.js";

/** Grips follow the selected cell, including a tap or right-click (#1801). */
export function TableCellTools({
  placement,
  onAction,
  focusEditor,
}: {
  readonly placement: ArtifactTablePlacement;
  readonly onAction: (action: TableAction) => void;
  /** Focuses the editor with its own selection, not the DOM's. */
  readonly focusEditor: () => void;
}) {
  return (
    <div className="artifact-table-tools">
      {(["column", "row"] as const).map((axis) => {
        const column = axis === "column";
        const label = column ? "Column Options" : "Row Options";
        return (
          <Menu.Root key={axis}>
            <Menu.Trigger
              className={`artifact-table-grip artifact-table-${axis}`}
              aria-label={label}
              title={label}
              style={{
                top: column ? placement.top : placement.row,
                left: column ? placement.column : placement.left,
              }}
            >
              {column ? (
                <GripHorizontal aria-hidden="true" />
              ) : (
                <GripVertical aria-hidden="true" />
              )}
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Positioner
                className="thread-menu-positioner"
                side={column ? "top" : "right"}
                sideOffset={4}
              >
                <Menu.Popup
                  className="thread-menu-popup thread-actions-menu"
                  aria-label={label}
                  // Keep typing in the cell after an action or Escape. A bare
                  // DOM focus can let the browser's caret replace the
                  // editor's selection, which drops the grips.
                  finalFocus={() => {
                    focusEditor();
                    return false;
                  }}
                >
                  {(column
                    ? ([
                        ["insert-left", "Insert Left"],
                        ["insert-right", "Insert Right"],
                      ] as const)
                    : ([
                        ["insert-above", "Insert Above"],
                        ["insert-below", "Insert Below"],
                      ] as const)
                  ).map(([action, text]) => (
                    <Menu.Item
                      key={action}
                      className="thread-menu-item"
                      onClick={() => onAction(action)}
                    >
                      {text}
                    </Menu.Item>
                  ))}
                  <Menu.Separator className="thread-menu-separator" />
                  <Menu.Item
                    className="thread-menu-item"
                    onClick={() =>
                      onAction(column ? "delete-column" : "delete-row")
                    }
                  >
                    {column ? "Delete Column" : "Delete Row"}
                  </Menu.Item>
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
        );
      })}
      <button
        type="button"
        className="artifact-table-add artifact-table-add-column"
        aria-label="Add Column"
        title="Add Column"
        style={{
          top: placement.top,
          left: placement.left + placement.width + 4,
          height: placement.height,
        }}
        onClick={() => {
          onAction("append-column");
          focusEditor();
        }}
      >
        <Plus aria-hidden="true" />
      </button>
      <button
        type="button"
        className="artifact-table-add artifact-table-add-row"
        aria-label="Add Row"
        title="Add Row"
        style={{
          top: placement.top + placement.height + 4,
          left: placement.left,
          width: placement.width,
        }}
        onClick={() => {
          onAction("append-row");
          focusEditor();
        }}
      >
        <Plus aria-hidden="true" />
      </button>
    </div>
  );
}
