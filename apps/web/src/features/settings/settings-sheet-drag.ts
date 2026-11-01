// The phone settings sheet drags down like a native one: a touch on its
// header, or on its content while that is scrolled to the top, that travels
// down follows the finger, and a release far enough down closes settings. A
// touch that travels sideways or up, or that starts on scrolled content or a
// text field, is left to the browser.

/** Travel before a touch becomes a drag, in either axis. */
const CLAIM_DISTANCE = 10;
/** A release this far down closes settings. */
const DISMISS_DISTANCE = 96;
/** Matches the phone sheet layout in styles.css. */
const SHEET_QUERY = "(max-width: 767px)";

const sheetOf = (node: HTMLElement) =>
  node.closest<HTMLElement>(".dx-app-frame");

/**
 * Whether something between the touch and the sheet owns it: a text field,
 * a canvas, or an element scrolled down that a pull would scroll back up.
 * Sideways scrollers such as the section pills keep sideways swipes through
 * the direction check in `move`.
 */
const ownsTouch = (target: EventTarget | null, boundary: Element) => {
  for (
    let element = target instanceof Element ? target : null;
    element !== null && element !== boundary;
    element = element.parentElement
  ) {
    if (
      element.matches(
        "input, textarea, select, canvas, [contenteditable]:not([contenteditable=false])",
      )
    )
      return true;
    const { overflowY } = getComputedStyle(element);
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      element.scrollTop > 0
    )
      return true;
  }
  return false;
};

/** A ref callback that drags the phone settings sheet down to close it. */
export const settingsSheetDrag =
  (close: () => void) => (node: HTMLElement | null) => {
    if (node === null) return;
    let gesture:
      | {
          readonly startX: number;
          readonly startY: number;
          dragging: boolean;
          offset: number;
        }
      | undefined;

    const show = (offset: number | undefined) => {
      const sheet = sheetOf(node);
      if (sheet === null) return;
      if (offset === undefined) {
        delete sheet.dataset.sheetDrag;
        sheet.style.removeProperty("transform");
        return;
      }
      sheet.dataset.sheetDrag = "";
      sheet.style.transform = `translateY(${offset}px)`;
    };

    const begin = (event: TouchEvent) => {
      const touch = event.touches[0];
      gesture = undefined;
      if (event.touches.length !== 1 || touch === undefined) return;
      if (!window.matchMedia(SHEET_QUERY).matches) return;
      if (ownsTouch(event.target, node)) return;
      gesture = {
        startX: touch.clientX,
        startY: touch.clientY,
        dragging: false,
        offset: 0,
      };
    };

    const move = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (gesture === undefined || touch === undefined) return;
      const dx = touch.clientX - gesture.startX;
      const dy = touch.clientY - gesture.startY;
      if (!gesture.dragging) {
        if (Math.abs(dx) < CLAIM_DISTANCE && Math.abs(dy) < CLAIM_DISTANCE)
          return;
        // Sideways or upward travel scrolls; only a pull down drags.
        if (dy <= 0 || Math.abs(dx) > dy) {
          gesture = undefined;
          return;
        }
        gesture.dragging = true;
      }
      if (event.cancelable) event.preventDefault();
      gesture.offset = Math.max(0, dy);
      show(gesture.offset);
    };

    const end = (event: TouchEvent) => {
      const finished = gesture;
      gesture = undefined;
      if (finished === undefined || !finished.dragging) return;
      show(undefined);
      if (event.type === "touchend" && finished.offset > DISMISS_DISTANCE)
        close();
    };

    node.addEventListener("touchstart", begin, { passive: true });
    node.addEventListener("touchmove", move, { passive: false });
    node.addEventListener("touchend", end);
    node.addEventListener("touchcancel", end);
    return () => {
      node.removeEventListener("touchstart", begin);
      node.removeEventListener("touchmove", move);
      node.removeEventListener("touchend", end);
      node.removeEventListener("touchcancel", end);
      if (gesture?.dragging) show(undefined);
    };
  };
