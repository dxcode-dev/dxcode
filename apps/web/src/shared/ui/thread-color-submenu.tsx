import type { ThreadData } from "@dx/api";
import { CircleDashed, Palette } from "lucide-react";
import {
  THREAD_COLOR_LABELS,
  THREAD_COLORS,
  type ThreadColor,
  threadColorAttributes,
} from "../thread-color.js";
import {
  MenuItem,
  MenuPopup,
  MenuSubmenuRoot,
  MenuSubmenuTrigger,
} from "./menu.js";
import { OrbIcon } from "./orb-icon.js";

/**
 * The Color submenu shared by the sidebar context menu and the Thread menu.
 * Context menu parts are Menu parts, so this renders inside either.
 */
export function ThreadColorSubmenu({
  thread,
  onSelect,
}: {
  readonly thread: Pick<
    ThreadData,
    "id" | "color" | "parentThreadId" | "parentColor"
  >;
  readonly onSelect: (color: ThreadColor | null) => void;
}) {
  return (
    <MenuSubmenuRoot>
      <MenuSubmenuTrigger>
        <Palette />
        <span>Color</span>
      </MenuSubmenuTrigger>
      <MenuPopup
        className="thread-color-popup"
        alignOffset={-4}
        aria-label="Thread color"
      >
        {THREAD_COLORS.map((color) => (
          <MenuItem
            key={color}
            className="thread-color-swatch"
            data-thread-color={color}
            data-current={thread.color === color ? "" : undefined}
            aria-label={THREAD_COLOR_LABELS[color]}
            title={THREAD_COLOR_LABELS[color]}
            onClick={() => onSelect(color)}
          >
            <OrbIcon reducedMotion />
          </MenuItem>
        ))}
        <MenuItem
          className="thread-color-swatch"
          // What Auto shows: a child on auto takes its parent's color.
          data-thread-color={
            threadColorAttributes({ ...thread, color: undefined })[
              "data-thread-color"
            ]
          }
          data-auto=""
          data-current={thread.color === undefined ? "" : undefined}
          aria-label="Auto color"
          title="Auto"
          onClick={() => onSelect(null)}
        >
          <CircleDashed />
        </MenuItem>
      </MenuPopup>
    </MenuSubmenuRoot>
  );
}
