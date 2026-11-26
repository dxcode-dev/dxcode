import type {
  ShellMessage,
  ShellRect,
} from "../../shared/native-shell/native-shell.js";

/**
 * The page's top rows, which move the window in a desktop shell the way a
 * title bar does: the shell draws no title bar of its own, so its window
 * controls sit in these rows (Electron calls these "app regions").
 */
const DRAG_ROWS = [
  ".product-sidebar .sidebar-topbar",
  ".thread-title-bar",
  ".page-topbar",
  ".settings-top-bar-row",
  ".artifact-header",
].join(", ");

/** What stays clickable inside a drag row. */
const CONTROLS = [
  "button",
  "a[href]",
  "input",
  "textarea",
  "select",
  "[role='button']",
  "[role='tab']",
  "[role='menuitem']",
  "[role='combobox']",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

/** The window's top strip, where the traffic lights sit (CSS pixels). */
const TOP_STRIP = 36;

const rectOf = (element: Element): ShellRect | undefined => {
  const box = element.getBoundingClientRect();
  if (box.width < 1 || box.height < 1) return undefined;
  return {
    x: Math.round(box.left),
    y: Math.round(box.top),
    width: Math.round(box.width),
    height: Math.round(box.height),
  };
};

/**
 * Tells the shell where the window can be dragged from, and again whenever
 * the layout changes (at most once a frame, and only when the areas moved).
 * Returns the function that stops watching.
 */
export const watchWindowDrag = (post: (message: ShellMessage) => void) => {
  let frame = 0;
  let last = "";
  const measure = () => {
    frame = 0;
    const regions: ShellRect[] = [];
    const holes: ShellRect[] = [];
    for (const row of document.querySelectorAll(DRAG_ROWS)) {
      const region = rectOf(row);
      if (region === undefined) continue;
      regions.push(region);
      for (const control of row.querySelectorAll(CONTROLS)) {
        const hole = rectOf(control);
        if (hole !== undefined) holes.push(hole);
      }
    }
    // A page with no top row (the home page with the sidebar closed) still
    // drags by its top strip, around whatever controls sit in it.
    if (!regions.some((region) => region.y <= 4)) {
      regions.push({ x: 0, y: 0, width: window.innerWidth, height: TOP_STRIP });
      for (const control of document.querySelectorAll(CONTROLS)) {
        const hole = rectOf(control);
        if (hole !== undefined && hole.y < TOP_STRIP) holes.push(hole);
      }
    }
    const key = JSON.stringify([regions, holes]);
    if (key === last) return;
    last = key;
    post({ type: "window-drag", regions, holes });
  };
  const schedule = () => {
    if (frame === 0) frame = requestAnimationFrame(measure);
  };
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["class", "style", "hidden", "data-state"],
  });
  window.addEventListener("resize", schedule);
  schedule();
  return () => {
    observer.disconnect();
    window.removeEventListener("resize", schedule);
    if (frame !== 0) cancelAnimationFrame(frame);
  };
};
