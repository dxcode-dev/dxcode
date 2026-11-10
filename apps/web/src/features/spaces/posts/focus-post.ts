/** How long a linked post stays highlighted, as a linked message does. */
const HIGHLIGHT_MS = 2_400;
/** Frames the post must stay in view before the request is done. */
const STEADY_FRAMES = 3;
/** Frames to try before giving up, as cards and Markdown settle. */
const MAX_FRAMES = 60;

/**
 * Brings a linked post into view and flashes it, as `?message=` does in a
 * Thread. Cards and images above it settle as they load, so it keeps the
 * post centered until it stays put; scrolling by hand ends the request
 * where the person is. Returns a cleanup for a ref callback.
 */
export const showLinkedPost = (row: HTMLElement, onShown?: () => void) =>
  showLinked(row, ".space-chat-scroll", onShown);

/**
 * Brings a linked row into view in the scroller around it (`scroller`, a
 * selector) and flashes it: a post in the chat, a comment in its panel.
 */
export const showLinked = (
  row: HTMLElement,
  scroller: string,
  onShown?: () => void,
) => {
  const view = row.closest<HTMLElement>(scroller);
  let frames = 0;
  let steady = 0;
  let stopped = false;
  let frame = 0;
  const stop = () => {
    stopped = true;
  };
  const options = { passive: true } as const;
  view?.addEventListener("wheel", stop, options);
  view?.addEventListener("touchstart", stop, options);
  const highlight = () => {
    onShown?.();
    row.setAttribute("data-notification-target", "");
    window.setTimeout(
      () => row.removeAttribute("data-notification-target"),
      HIGHLIGHT_MS,
    );
  };
  const settle = () => {
    frames += 1;
    if (view === null || stopped) return highlight();
    const rowRect = row.getBoundingClientRect();
    const viewRect = view.getBoundingClientRect();
    const tall = rowRect.height > viewRect.height;
    const inView = tall
      ? rowRect.top >= viewRect.top - 1 && rowRect.top <= viewRect.top + 64
      : rowRect.top >= viewRect.top - 1 &&
        rowRect.bottom <= viewRect.bottom + 1;
    steady = inView ? steady + 1 : 0;
    if (!inView) row.scrollIntoView({ block: tall ? "start" : "center" });
    if (steady >= STEADY_FRAMES || frames >= MAX_FRAMES) return highlight();
    frame = requestAnimationFrame(settle);
  };
  frame = requestAnimationFrame(settle);
  return () => {
    cancelAnimationFrame(frame);
    view?.removeEventListener("wheel", stop);
    view?.removeEventListener("touchstart", stop);
  };
};
