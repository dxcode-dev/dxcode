import { Ellipsis } from "lucide-react";
import * as React from "react";
import {
  ContextMenuRoot,
  ContextMenuTrigger,
  MenuPopup,
  MenuRoot,
  MenuTrigger,
} from "../../shared/ui/menu.js";
import { copyFocusedMessage, type MessageMenuKind } from "./message-copy.js";
import { canEditMessage, MessageEditContext } from "./message-edit.js";
import { MessageMenuItems } from "./message-menu-items.js";
import { MessageReactionAction } from "./sharing/message-reactions.js";
import type { TranscriptRow } from "./transcript-view-model.js";

export type MessageMenuRow = Extract<
  TranscriptRow,
  { readonly kind: MessageMenuKind }
>;

/** A bare `e`, which edits the message as the menu's Edit hint shows. */
const editKey = (event: React.KeyboardEvent) =>
  event.key.toLowerCase() === "e" &&
  !event.ctrlKey &&
  !event.metaKey &&
  !event.altKey &&
  !event.shiftKey;

/** `e` in an open menu chooses Edit, which closes the menu as a click does. */
const chooseEditItem = (event: React.KeyboardEvent<HTMLElement>) => {
  if (!editKey(event)) return;
  const item = event.currentTarget.querySelector<HTMLElement>(
    "[data-message-edit]",
  );
  if (item === null) return;
  event.preventDefault();
  event.stopPropagation();
  item.click();
};

/**
 * A message's menu: `⋯` at its top, on the side the message sits on, while
 * it is hovered or selected (clicked, tapped, or focused), with the time;
 * and right-click. A long press on touch selects text instead. The items render with the page, so the first open
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
  const editing = React.use(MessageEditContext);
  const editable = canEditMessage(row, editing);
  return (
    <ContextMenuRoot>
      <ContextMenuTrigger
        render={render}
        // A long press on touch selects text, as everywhere else on a
        // phone; the menu opening on the same press broke the selection.
        // On touch the menu stays on ⋯, and the selection toolbar copies.
        onTouchStart={(event: React.TouchEvent<HTMLElement>) =>
          (
            event as React.TouchEvent<HTMLElement> & {
              preventBaseUIHandler: () => void;
            }
          ).preventBaseUIHandler()
        }
        onKeyDown={(event: React.KeyboardEvent<HTMLElement>) => {
          // Escape deselects the message, as clicking elsewhere does.
          if (event.key === "Escape" && event.target === event.currentTarget)
            event.currentTarget.blur();
          else if (
            editable &&
            editKey(event) &&
            event.target === event.currentTarget
          ) {
            event.preventDefault();
            editing?.start(row);
          } else copyFocusedMessage(event, row.text);
        }}
      >
        {/* Zero height at the message's top; sticky while the message is
            selected, so ⋯ stays in view as a long message scrolls. */}
        <div className="message-actions-anchor" data-side={side}>
          <div className="message-actions-controls">
            <MessageReactionAction row={row} />
            <MenuRoot>
              <MenuTrigger
                className="message-actions-button"
                aria-label="Message Actions"
              >
                <Ellipsis aria-hidden="true" />
              </MenuTrigger>
              <MenuPopup
                className="message-menu"
                onKeyDown={editable ? chooseEditItem : undefined}
                side="bottom"
                align={side === "right" ? "end" : "start"}
              >
                <MessageMenuItems row={row} header />
              </MenuPopup>
            </MenuRoot>
          </div>
        </div>
        {children}
      </ContextMenuTrigger>
      <MenuPopup
        className="message-menu"
        sideOffset={0}
        onKeyDown={editable ? chooseEditItem : undefined}
      >
        <MessageMenuItems row={row} />
      </MenuPopup>
    </ContextMenuRoot>
  );
}
