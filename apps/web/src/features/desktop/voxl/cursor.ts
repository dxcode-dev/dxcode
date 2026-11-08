// The remote cursor, drawn by the browser so pointer movement has no stream
// latency. Ported from voxl's web client (web/src/client/cursor.ts at
// tembo/voxl 176f8be, MIT, © 2026 Tembo). Cursor messages: type byte, pad,
// width, height, hot x, hot y (u16 each), serial (u32), then RGBA.

// On-screen cursor size bounds in CSS pixels, applied to the image's longer
// side. 24 is the standard pointer size (Xcursor's default), so a desktop
// scaled down into a small pane keeps a normal-sized pointer.
const MIN_CURSOR_PX = 24;
const MAX_CURSOR_PX = 128;

/**
 * Shows cursor images on `target`. `scale` is on-screen CSS pixels per
 * desktop pixel.
 */
export function createCursor(target: HTMLElement, scale: () => number) {
  let message: ArrayBuffer | null = null;
  const scaled = document.createElement("canvas");

  const apply = () => {
    if (!message) return;
    const view = new DataView(message);
    const w = view.getUint16(2);
    const h = view.getUint16(4);
    const hx = view.getUint16(6);
    const hy = view.getUint16(8);
    if (!w || !h || message.byteLength < 14 + w * h * 4) {
      target.style.cursor = "none";
      return;
    }
    const source = document.createElement("canvas");
    source.width = w;
    source.height = h;
    source
      .getContext("2d")
      ?.putImageData(
        new ImageData(new Uint8ClampedArray(message, 14, w * h * 4), w, h),
        0,
        0,
      );
    const dpr = window.devicePixelRatio || 1;
    const size = Math.max(w, h);
    const s = Math.min(
      Math.max(scale(), MIN_CURSOR_PX / size),
      MAX_CURSOR_PX / size,
    );
    const cw = Math.max(1, Math.round(w * s));
    const ch = Math.max(1, Math.round(h * s));
    scaled.width = Math.max(1, Math.round(cw * dpr));
    scaled.height = Math.max(1, Math.round(ch * dpr));
    const context = scaled.getContext("2d");
    if (!context) return;
    context.imageSmoothingQuality = "high";
    context.clearRect(0, 0, scaled.width, scaled.height);
    context.drawImage(source, 0, 0, scaled.width, scaled.height);
    const url = scaled.toDataURL("image/png");
    const hsx = Math.round(hx * s);
    const hsy = Math.round(hy * s);
    target.style.cursor =
      dpr > 1
        ? `image-set(url(${url}) ${dpr}x) ${hsx} ${hsy}, default`
        : `url(${url}) ${hsx} ${hsy}, default`;
  };

  return {
    set(buffer: ArrayBuffer) {
      message = buffer;
      apply();
    },
    apply,
  };
}
