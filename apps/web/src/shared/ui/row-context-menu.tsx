import type { ReactNode } from "react";
import * as React from "react";
import { ContextMenuRoot, ContextMenuTrigger, MenuPopup } from "./menu.js";

const menuPopup = (items: ReactNode) => (
  <MenuPopup
    sideOffset={0}
    // Only a keyboard close returns focus to the row; after a click
    // the row would keep a focus highlight beside the new selection.
    finalFocus={(closeType) => closeType === "keyboard"}
  >
    {items}
  </MenuPopup>
);

/** What one row's menu shows, registered with the list's shared menu. */
interface ContextMenuRow {
  /** Remounts the items when the menu opens for another row. */
  readonly key: string;
  readonly items: () => ReactNode;
  readonly onOpenChange?: (open: boolean) => void;
}

/** Each row's menu, by the row's trigger element, for the list's one menu. */
const SharedMenuRows = React.createContext<
  Map<Element, ContextMenuRow> | undefined
>(undefined);

/**
 * One context menu for every `RowContextMenu` row inside it (#1462), such
 * as the sidebar's Threads and Spaces. A row registers what its menu
 * offers; right-click, a long press, or a `contextmenu` event opens the
 * menu for the row under it, so a list of rows mounts one menu, not one
 * each.
 */
export function SharedRowContextMenu({
  children,
}: {
  readonly children: ReactNode;
}) {
  const [rows] = React.useState(() => new Map<Element, ContextMenuRow>());
  const [active, setActive] = React.useState<ContextMenuRow>();
  return (
    <SharedMenuRows.Provider value={rows}>
      <ContextMenuRoot
        onOpenChange={(open, details) => {
          if (!open) return;
          const target = details.event.target;
          const row =
            target instanceof Element
              ? target.closest(".thread-context-trigger")
              : null;
          const menu = row === null ? undefined : rows.get(row);
          // Outside any row there is nothing to offer.
          if (menu === undefined) {
            details.cancel();
            return;
          }
          setActive(menu);
          menu.onOpenChange?.(true);
        }}
      >
        <ContextMenuTrigger render={<div className="thread-context-scope" />}>
          {children}
        </ContextMenuTrigger>
        {menuPopup(
          active === undefined ? null : (
            <React.Fragment key={active.key}>{active.items()}</React.Fragment>
          ),
        )}
      </ContextMenuRoot>
    </SharedMenuRows.Provider>
  );
}

/**
 * A row's context menu: inside `SharedRowContextMenu` the row only
 * registers `items`; elsewhere it mounts a menu of its own. `menuKey` names
 * the row, such as its Thread's ID.
 */
export function RowContextMenu({
  menuKey,
  items,
  onOpenChange,
  children,
}: {
  readonly menuKey: string;
  readonly items: () => ReactNode;
  readonly onOpenChange?: (open: boolean) => void;
  readonly children: ReactNode;
}) {
  const rows = React.useContext(SharedMenuRows);
  if (rows !== undefined)
    return (
      <div
        className="thread-context-trigger"
        ref={(node) => {
          if (node === null) return;
          rows.set(node, { key: menuKey, items, onOpenChange });
          return () => {
            rows.delete(node);
          };
        }}
      >
        {children}
      </div>
    );
  return (
    <ContextMenuRoot onOpenChange={onOpenChange}>
      <ContextMenuTrigger render={<div className="thread-context-trigger" />}>
        {children}
      </ContextMenuTrigger>
      {menuPopup(items())}
    </ContextMenuRoot>
  );
}
