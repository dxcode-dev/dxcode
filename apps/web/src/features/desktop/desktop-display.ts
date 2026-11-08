// How the viewer sizes the remote desktop and hands the remote clipboard to
// the local one.

// The remote desktop follows the pane's size at its pixel density, at least
// a usable laptop-sized desktop (the canvas letterboxes when the pane is
// smaller) and at most about 1080p of encoded pixels. voxl takes widths in
// multiples of 8 and even heights.
const remoteDisplaySize = (
  width: number,
  height: number,
  devicePixelRatio: number,
) => {
  const density = Math.min(Math.max(devicePixelRatio || 1, 1), 2);
  const minWidth = Math.round(960 * density);
  const minHeight = Math.round(540 * density);
  const maxPixels = Math.max(1920 * 1200, minWidth * minHeight);
  let w = Math.max(Math.round(width * density), minWidth);
  let h = Math.max(Math.round(height * density), minHeight);
  if (w * h > maxPixels) {
    const shrink = Math.sqrt(maxPixels / (w * h));
    w = Math.max(Math.floor(w * shrink), minWidth);
    h = Math.max(Math.floor(h * shrink), minHeight);
  }
  return { w: w - (w % 8), h: h - (h % 2) };
};

/**
 * Asks for a remote desktop that fits `surface`, now and whenever it
 * changes size. Returns the function that stops following it.
 */
export const followPaneSize = (
  surface: HTMLElement,
  resize: (width: number, height: number) => void,
) => {
  const fit = () => {
    const box = surface.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return;
    const size = remoteDisplaySize(
      box.width,
      box.height,
      window.devicePixelRatio,
    );
    resize(size.w, size.h);
  };
  const observer = new ResizeObserver(fit);
  observer.observe(surface);
  fit();
  return () => observer.disconnect();
};

/** Writes remote clipboard text or a PNG image to the local clipboard. */
export const writeLocalClipboard = (content: string | Blob) => {
  const clipboard = navigator.clipboard;
  if (typeof content === "string")
    clipboard?.writeText(content).catch(() => undefined);
  else if (typeof ClipboardItem !== "undefined")
    clipboard
      ?.write([new ClipboardItem({ "image/png": content })])
      .catch(() => undefined);
};
