/** A box in the viewport's coordinates, as `getBoundingClientRect` gives. */
export interface ViewportBox {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

/**
 * Room the phone's own selection menu takes (iOS's Copy, Look Up, Share;
 * Android's Copy, Share, Select All) with its gap to the text. It opens
 * above the selection when this much room is there, else below the handles.
 */
export const NATIVE_MENU_ROOM = 56;
/** The selection handles hanging under the text on a touch screen. */
export const TOUCH_HANDLE_ROOM = 32;
const GAP = 6;
const EDGE = 8;

/**
 * Where the selection menu goes, so it never covers the device's own menu.
 *
 * With a mouse it sits under the selection, or over it when there is no
 * room under it. (A right-click menu opens at the pointer instead; the menu
 * hides while it shows.)
 *
 * On a touch screen the phone's menu takes the band over the selection, or,
 * near the top of the screen, the band under the handles. The menu takes
 * the other side: under the handles, else over the phone's menu; or under
 * the phone's menu when that one went below.
 */
export function placeSelectionMenu({
  selection,
  size,
  bounds,
  screen,
  touch,
}: {
  readonly selection: ViewportBox;
  readonly size: { readonly width: number; readonly height: number };
  /** Where the menu may go: the scrolled area of messages, on screen. */
  readonly bounds: ViewportBox;
  /** The visible screen, which the phone's own menu keeps to. */
  readonly screen: ViewportBox;
  readonly touch: boolean;
}) {
  const nativeAbove = selection.top - screen.top >= NATIVE_MENU_ROOM;
  const candidates = !touch
    ? [selection.bottom + GAP, selection.top - GAP - size.height]
    : nativeAbove
      ? [
          selection.bottom + TOUCH_HANDLE_ROOM,
          selection.top - NATIVE_MENU_ROOM - size.height,
        ]
      : [selection.bottom + TOUCH_HANDLE_ROOM + NATIVE_MENU_ROOM];
  const lowest = bounds.bottom - EDGE - size.height;
  const top =
    candidates.find((top) => top >= bounds.top + EDGE && top <= lowest) ??
    Math.max(bounds.top + EDGE, Math.min(candidates[0] ?? lowest, lowest));
  const center = (selection.left + selection.right) / 2;
  const left = Math.min(
    Math.max(bounds.left + EDGE, center - size.width / 2),
    bounds.right - EDGE - size.width,
  );
  return { top, left };
}
