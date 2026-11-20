import type { SpaceData } from "@dx/api";
import {
  Archive,
  Copy,
  Hash,
  Link2,
  LogOut,
  Pencil,
  Trash2,
} from "lucide-react";
import { copyThreadId, copyThreadUrl } from "../../shared/thread-copy.js";
import {
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSubmenuRoot,
  MenuSubmenuTrigger,
} from "../../shared/ui/menu.js";

/**
 * A sidebar Space row's context menu, as its page's Space Actions offer:
 * the owner edits, archives, or deletes it; a member leaves it; anyone
 * copies its URL or ID. An action left undefined is not offered.
 */
export function SpaceContextMenuItems({
  space,
  onEdit,
  onArchive,
  onDelete,
  onLeave,
}: {
  readonly space: Pick<SpaceData, "threadId">;
  readonly onEdit?: () => void;
  readonly onArchive?: () => void;
  readonly onDelete?: () => void;
  readonly onLeave?: () => void;
}) {
  const manage =
    onArchive !== undefined || onDelete !== undefined || onLeave !== undefined;
  return (
    <>
      {onEdit === undefined ? null : (
        <>
          <MenuItem onClick={onEdit}>
            <Pencil />
            <span>Edit Space…</span>
          </MenuItem>
          <MenuSeparator />
        </>
      )}
      {onArchive === undefined ? null : (
        <MenuItem onClick={onArchive}>
          <Archive />
          <span>Archive Space</span>
        </MenuItem>
      )}
      {onLeave === undefined ? null : (
        <MenuItem onClick={onLeave}>
          <LogOut />
          <span>Leave Space</span>
        </MenuItem>
      )}
      {onDelete === undefined ? null : (
        <MenuItem tone="danger" onClick={onDelete}>
          <Trash2 />
          <span>Delete Space…</span>
        </MenuItem>
      )}
      {manage ? <MenuSeparator /> : null}
      <MenuSubmenuRoot>
        <MenuSubmenuTrigger>
          <Copy />
          <span>Copy</span>
        </MenuSubmenuTrigger>
        <MenuPopup alignOffset={-4}>
          <MenuItem
            onClick={() => void copyThreadUrl(space.threadId, "Space URL")}
          >
            <Link2 />
            <span>Space URL</span>
          </MenuItem>
          <MenuItem
            onClick={() => void copyThreadId(space.threadId, "Space ID")}
          >
            <Hash />
            <span>Space ID</span>
          </MenuItem>
        </MenuPopup>
      </MenuSubmenuRoot>
    </>
  );
}
