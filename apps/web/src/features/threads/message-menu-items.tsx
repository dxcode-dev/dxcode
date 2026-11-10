import { Menu } from "@base-ui/react/menu";
import { ClipboardType, Copy, Link2, Pencil } from "lucide-react";
import * as React from "react";
import { ShortcutKeycaps } from "../../shared/commands/shortcut-keycaps.js";
import type { MessageMenuRow } from "./message-actions.js";
import {
  copyMessageLink,
  copyMessageText,
  copyWithStyling,
} from "./message-copy.js";
import { canEditMessage, MessageEditContext } from "./message-edit.js";
import { messageLinkId, messageLinkUrl } from "./message-link.js";

const timeFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** Ctrl+C, or ⌘C on Apple devices, as the keymap shows it. */
const copyKeycaps = /Mac|iPhone|iPad/.test(navigator.userAgent)
  ? ["⌘", "C"]
  : ["Ctrl", "C"];

/**
 * A message's menu items. A prompt copies as written; a reply copies as
 * Markdown or as the styled text it shows. `header` adds the time, as the
 * `⋯` menu shows it.
 */
export function MessageMenuItems({
  row,
  header = false,
}: {
  readonly row: MessageMenuRow;
  readonly header?: boolean;
}) {
  const linkId = messageLinkId(row);
  const link = linkId === undefined ? undefined : messageLinkUrl(linkId);
  const user = row.kind === "user-prompt";
  const editing = React.use(MessageEditContext);
  return (
    <>
      {header && row.sentAt !== undefined ? (
        <time className="message-menu-time" dateTime={row.sentAt}>
          {timeFormat.format(new Date(row.sentAt))}
        </time>
      ) : null}
      {canEditMessage(row, editing) ? (
        <Menu.Item
          className="thread-context-item"
          data-message-edit=""
          onClick={() => editing?.start(row)}
        >
          <Pencil />
          <span>Edit</span>
          <ShortcutKeycaps keycaps={["E"]} />
        </Menu.Item>
      ) : null}
      <Menu.Item
        className="thread-context-item"
        onClick={() => void copyMessageText(row.text)}
      >
        <Copy />
        <span>{user ? "Copy Message" : "Copy as Markdown"}</span>
        <ShortcutKeycaps keycaps={copyKeycaps} />
      </Menu.Item>
      {user ? null : (
        <Menu.Item
          className="thread-context-item"
          onClick={() => {
            const content = document
              .getElementById(row.id)
              ?.querySelector<HTMLElement>(".message-content");
            void copyWithStyling(content ?? null, content?.innerText ?? "");
          }}
        >
          <ClipboardType />
          <span>Copy with Styling</span>
        </Menu.Item>
      )}
      {link === undefined ? null : (
        <Menu.Item
          className="thread-context-item"
          onClick={() => void copyMessageLink(link)}
        >
          <Link2 />
          <span>Copy Link</span>
        </Menu.Item>
      )}
    </>
  );
}
