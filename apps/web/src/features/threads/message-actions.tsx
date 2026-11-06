import { ContextMenu } from "@base-ui/react/context-menu";
import { Menu } from "@base-ui/react/menu";
import { Ellipsis } from "lucide-react";
import type * as React from "react";
import { copyFocusedMessage, type MessageMenuKind } from "./message-copy.js";
import { MessageMenuItems } from "./message-menu-items.js";
import type { TranscriptRow } from "./transcript-view-model.js";

export type MessageMenuRow = Extract<
  TranscriptRow,
  { readonly kind: MessageMenuKind }
>;

/**
 * A message's menu: `⋯` at its top, on the side the message sits on, while
 * it is hovered or selected (clicked, tapped, or focused), with the time; right-click; and a
 * long press on touch. The items render with the page, so the first open
 * shows the whole menu at once. `render` is the message's element; `children` its
 * content.
 */
export function MessageActions({
  row,
  side,
  render,
  children,
}: {
  readonly row: MessageMenuRow;
  /** The side the message sits on, which ⋯ and its menu follow. */
  readonly side: "left" | "right";
  readonly render: React.ReactElement;
  readonly children: React.ReactNode;
}) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger
        render={render}
        onKeyDown={(event: React.KeyboardEvent<HTMLElement>) => {
          // Escape deselects the message, as clicking elsewhere does.
          if (event.key === "Escape" && event.target === event.currentTarget)
            event.currentTarget.blur();
          else copyFocusedMessage(event, row.text);
        }}
      >
        {/* Zero height at the message's top; sticky while the message is
            selected, so ⋯ stays in view as a long message scrolls. */}
        <div className="message-actions-anchor" data-side={side}>
          <div className="message-actions-controls">
            <Menu.Root>
              <Menu.Trigger
                className="message-actions-button"
                aria-label="Message Actions"
              >
                <Ellipsis aria-hidden="true" />
              </Menu.Trigger>
              <Menu.Portal>
                <Menu.Positioner
                  className="thread-context-positioner"
                  side="bottom"
                  align={side === "right" ? "end" : "start"}
                  sideOffset={4}
                >
                  <Menu.Popup className="thread-context-menu message-menu">
                    <MessageMenuItems row={row} header />
                  </Menu.Popup>
                </Menu.Positioner>
              </Menu.Portal>
            </Menu.Root>
          </div>
        </div>
        {children}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="thread-context-positioner">
          <ContextMenu.Popup className="thread-context-menu message-menu">
            <MessageMenuItems row={row} />
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
