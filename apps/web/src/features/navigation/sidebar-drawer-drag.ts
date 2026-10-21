// The phone sidebar drawer drags like a native one: once a touch travels
// sideways it follows the finger, and on release it settles open or closed
// by how far and how fast the finger went. A touch that does not travel
// sideways never moves it.

/** Travel before a touch becomes a drag, in either axis. */
const CLAIM_DISTANCE = 10;
/** A release at least this fast (px/ms) settles in its direction. */
const FLICK_SPEED = 0.35;
/** Release speed is the finger's average over this last stretch (ms). */
const SPEED_WINDOW = 100;
/** iOS starts its own back swipe from this strip along the left edge. */
const EDGE_STRIP = 24;

const root = () => document.documentElement;
const drawerElement = () =>
  document.querySelector<HTMLElement>(".mobile-sidebar-drawer");
const scrimElement = () =>
  document.querySelector<HTMLElement>(".mobile-sidebar-scrim");
export const drawerIsOpen = () =>
  document.querySelector(".mobile-sidebar-drawer[data-open]") !== null;

/** How far the drawer travels from closed to open. */
const travelDistance = () => {
  const drawer = drawerElement();
  if (drawer !== null)
    return (
      drawer.offsetWidth + Number.parseFloat(getComputedStyle(drawer).left)
    );
  // Before its first open the drawer is not mounted; this matches its CSS.
  const width = window.innerWidth;
  return (width <= 639 ? width * 0.8 : Math.min(312, width - 16)) + 8;
};

/**
 * Pins the drawer and its scrim at `progress` (0 closed, 1 open). Only
 * those two elements change per move; a variable on the root would restyle
 * the whole page on every frame.
 */
const showProgress = (progress: number, travel: number) => {
  if (!root().hasAttribute("data-sidebar-drag"))
    root().setAttribute("data-sidebar-drag", "");
  const drawer = drawerElement();
  if (drawer !== null)
    drawer.style.transform = `translateX(${(progress - 1) * travel}px)`;
  const scrim = scrimElement();
  if (scrim !== null) scrim.style.opacity = String(progress);
};

/** The drawer's open and close transitions take 385ms. */
const SETTLE_MS = 450;
let settling: ReturnType<typeof setTimeout> | undefined;

/**
 * Hands the drawer back to its CSS transitions, which carry it from where
 * the finger left it. Settling closed is pinned at once, before React
 * closes the dialog, so the drawer never starts back toward open.
 */
const release = (settleOpen: boolean) => {
  clearTimeout(settling);
  if (settleOpen) root().removeAttribute("data-sidebar-settle");
  else {
    root().setAttribute("data-sidebar-settle", "closed");
    settling = setTimeout(
      () => root().removeAttribute("data-sidebar-settle"),
      SETTLE_MS,
    );
  }
  drawerElement()?.style.removeProperty("transform");
  scrimElement()?.style.removeProperty("opacity");
  root().removeAttribute("data-sidebar-drag");
};

/**
 * Touches that belong to something else: typing and selecting text, the
 * Terminal and Desktop canvases, and anything the person scrolls sideways
 * (code blocks, diffs, tables).
 */
const ownsHorizontalTouch = (target: EventTarget | null, boundary: Element) => {
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
    const overflow = getComputedStyle(element).overflowX;
    if (
      (overflow === "auto" || overflow === "scroll") &&
      element.scrollWidth > element.clientWidth
    )
      return true;
  }
  return false;
};

const isControl = (target: EventTarget | null) =>
  target instanceof Element &&
  target.closest("button, a, [role=button], label, summary") !== null;

/**
 * A ref callback that drags the drawer. `opening` attaches to the page and
 * pulls the closed drawer out from a touch in the left half; otherwise it
 * attaches to the open drawer or its scrim and pushes it back.
 */
export const sidebarDrawerDrag =
  (
    opening: boolean,
    open: () => void,
    close: () => void,
    /** Mounts the closed drawer, so a drag never waits on its first render. */
    prepare: () => void = () => undefined,
  ) =>
  (node: HTMLElement | null) => {
    if (node === null) return;
    let gesture:
      | {
          readonly startX: number;
          readonly startY: number;
          dragging: boolean;
          travel: number;
          progress: number;
          trail: Array<{ readonly x: number; readonly time: number }>;
        }
      | undefined;

    const begin = (event: TouchEvent) => {
      const touch = event.touches[0];
      gesture = undefined;
      if (event.touches.length !== 1 || touch === undefined) return;
      if (drawerIsOpen() === opening) return;
      if (opening && touch.clientX > window.innerWidth / 2) return;
      if (ownsHorizontalTouch(event.target, node)) return;
      if (opening) prepare();
      // Claim the edge strip so iOS does not start its back swipe there;
      // controls in the strip keep their taps.
      if (opening && touch.clientX < EDGE_STRIP && !isControl(event.target))
        event.preventDefault();
      gesture = {
        startX: touch.clientX,
        startY: touch.clientY,
        dragging: false,
        travel: 0,
        progress: opening ? 0 : 1,
        trail: [{ x: touch.clientX, time: event.timeStamp }],
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
        // Vertical scrolling, or a push the wrong way, is not a drag.
        if (Math.abs(dy) >= Math.abs(dx) || dx > 0 !== opening) {
          gesture = undefined;
          return;
        }
        gesture.dragging = true;
        gesture.travel = travelDistance();
        showProgress(gesture.progress, gesture.travel);
        if (opening) open();
      }
      event.preventDefault();
      // Measured once mounted; the first open starts from the CSS estimate.
      if (opening && drawerElement() !== null)
        gesture.travel = travelDistance();
      const from = opening ? 0 : 1;
      // The drawer keeps the offset it had when the drag took hold.
      const claimed = opening ? CLAIM_DISTANCE : -CLAIM_DISTANCE;
      gesture.progress = Math.min(
        1,
        Math.max(0, from + (dx - claimed) / gesture.travel),
      );
      gesture.trail.push({ x: touch.clientX, time: event.timeStamp });
      while (
        gesture.trail.length > 2 &&
        event.timeStamp - (gesture.trail[0]?.time ?? 0) > SPEED_WINDOW
      )
        gesture.trail.shift();
      showProgress(gesture.progress, gesture.travel);
    };

    const end = () => {
      const finished = gesture;
      gesture = undefined;
      if (finished === undefined || !finished.dragging) return;
      const first = finished.trail[0];
      const last = finished.trail.at(-1);
      const speed =
        first === undefined || last === undefined || last.time === first.time
          ? 0
          : (last.x - first.x) / (last.time - first.time);
      const settleOpen =
        Math.abs(speed) >= FLICK_SPEED ? speed > 0 : finished.progress >= 0.5;
      release(settleOpen);
      if (!settleOpen) close();
    };

    node.addEventListener("touchstart", begin, { passive: false });
    node.addEventListener("touchmove", move, { passive: false });
    node.addEventListener("touchend", end);
    node.addEventListener("touchcancel", end);
    return () => {
      node.removeEventListener("touchstart", begin);
      node.removeEventListener("touchmove", move);
      node.removeEventListener("touchend", end);
      node.removeEventListener("touchcancel", end);
      if (gesture?.dragging) release(drawerIsOpen());
    };
  };
