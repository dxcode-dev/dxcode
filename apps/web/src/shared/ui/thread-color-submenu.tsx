import { Menu } from "@base-ui/react/menu";
import type { ThreadData } from "@dx/api";
import { ChevronRight, CircleDashed, Palette } from "lucide-react";
import {
  THREAD_COLOR_LABELS,
  THREAD_COLORS,
  type ThreadColor,
  threadColorAttributes,
} from "../thread-color.js";
import { OrbIcon } from "./orb-icon.js";

/**
 * The Color submenu shared by the sidebar context menu and the Thread menu.
 * Context menu parts are Menu parts, so this renders inside either.
 */
export function ThreadColorSubmenu({
  thread,
  itemClassName,
  onSelect,
}: {
  readonly thread: Pick<
    ThreadData,
    "id" | "color" | "parentThreadId" | "parentColor"
  >;
  readonly itemClassName: string;
  readonly onSelect: (color: ThreadColor | null) => void;
}) {
  return (
    <Menu.SubmenuRoot>
      <Menu.SubmenuTrigger className={itemClassName}>
        <Palette />
        <span>Color</span>
        <ChevronRight />
      </Menu.SubmenuTrigger>
      <Menu.Portal>
        <Menu.Positioner
          className="thread-menu-positioner"
          sideOffset={4}
          alignOffset={-4}
        >
          <Menu.Popup className="thread-color-popup" aria-label="Thread color">
            {THREAD_COLORS.map((color) => (
              <Menu.Item
                key={color}
                className="thread-color-swatch"
                data-thread-color={color}
                data-current={thread.color === color ? "" : undefined}
                aria-label={THREAD_COLOR_LABELS[color]}
                title={THREAD_COLOR_LABELS[color]}
                onClick={() => onSelect(color)}
              >
                <OrbIcon reducedMotion />
              </Menu.Item>
            ))}
            <Menu.Item
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
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.SubmenuRoot>
  );
}
