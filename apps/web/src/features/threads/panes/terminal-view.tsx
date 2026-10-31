import { Menu } from "@base-ui/react/menu";
import { Ellipsis, RefreshCw } from "lucide-react";
import type * as React from "react";

/** The Terminal with a floating `⋯` of Terminal actions at its top right. */
export function TerminalView({
  children,
}: {
  readonly children: React.ReactNode;
}) {
  return (
    <div className="pane-terminal-view">
      {children}
      <Menu.Root>
        <Menu.Trigger
          className="pane-terminal-actions"
          aria-label="Terminal Actions"
          title="Terminal Actions"
        >
          <Ellipsis aria-hidden="true" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner
            className="thread-menu-positioner"
            align="end"
            sideOffset={4}
          >
            <Menu.Popup className="thread-menu-popup thread-actions-menu">
              <Menu.Item
                className="thread-menu-item"
                nativeButton
                render={
                  <button type="submit" form="thread-terminal-environment" />
                }
              >
                <RefreshCw aria-hidden="true" />
                <span>Refresh Environment</span>
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </div>
  );
}
