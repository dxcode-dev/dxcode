import { effect, frameLoop, init, sampler, surface } from "vgpu";
import type { DxMarkState } from "./dx-mark.js";
import shaderSource from "./dx-mark.wgsl?raw";

const stateValue: Record<DxMarkState, number> = {
  idle: 0,
  thinking: 1,
  working: 2,
  complete: 3,
  error: 4,
  loading: 5,
};

type Rgba = readonly [number, number, number, number];

/** The mark's CSS color (`brand.css`, per state and light or dark page). */
const markInk = (mark: HTMLElement | null): Rgba => {
  const channels =
    mark === null
      ? undefined
      : getComputedStyle(mark)
          .color.match(/[\d.]+/g)
          ?.slice(0, 3)
          .map((channel) => Number(channel) / 255);
  return channels?.length === 3
    ? [channels[0] ?? 1, channels[1] ?? 1, channels[2] ?? 1, 1]
    : [0.965, 1, 0.96, 1];
};

/**
 * The loading waterline beside an ink: halfway to white for a light ink
 * (a dark page), a third darker for a dark ink (a light page).
 */
const waterline = ([red, green, blue]: Rgba): Rgba =>
  0.2126 * red + 0.7152 * green + 0.0722 * blue > 0.5
    ? [(red + 1) / 2, (green + 1) / 2, (blue + 1) / 2, 1]
    : [red * 0.66, green * 0.66, blue * 0.66, 1];

/** Creates the offscreen canvas used to rasterize the canonical dx glyph. */
const makeGlyphCanvas = (width: number, height: number) => {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
};

/** Connects one mark canvas to WebGPU and returns its complete teardown routine. */
export function mountDxMark(
  canvas: HTMLCanvasElement,
  state: DxMarkState,
  interactive: boolean,
  still = false,
) {
  let disposed = false;
  let teardown: () => void = () => undefined;
  // The mark shows its text fallback until this canvas draws a frame.
  const mark = canvas.parentElement;
  const pointer = { x: 0.5, y: 0.5 };
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  // Logo Animation off holds the mark as reduced motion does.
  const motionless = () => still || reducedMotion.matches;
  const handlePointerMove = (event: PointerEvent) => {
    if (!interactive || state === "error" || state === "loading") return;
    const bounds = canvas.getBoundingClientRect();
    pointer.x = (event.clientX - bounds.left) / Math.max(bounds.width, 1);
    pointer.y = (event.clientY - bounds.top) / Math.max(bounds.height, 1);
  };
  const handlePointerLeave = () => {
    pointer.x = 0.5;
    pointer.y = 0.5;
  };
  canvas.addEventListener("pointermove", handlePointerMove);
  canvas.addEventListener("pointerleave", handlePointerLeave);

  void (async () => {
    try {
      await document.fonts.ready;
      const gpu = await init();
      if (disposed) {
        gpu.dispose();
        return;
      }
      const target = surface(gpu, canvas, {
        alphaMode: "premultiplied",
        dpr: [1, 2],
      });
      const textureWidth = 1024;
      const textureHeight = 660;
      const glyphCanvas = makeGlyphCanvas(textureWidth, textureHeight);
      const context = glyphCanvas.getContext("2d");
      if (context === null) throw new Error("2D glyph canvas unavailable");
      const fontSize = Math.min(textureWidth * 0.51, textureHeight * 0.53);
      context.fillStyle = "white";
      context.font = `italic 700 ${fontSize}px "DM Sans", system-ui, sans-serif`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.letterSpacing = `${fontSize * -0.145}px`;
      // Center the ink, not the advance box: the italic's overhang and the
      // trailing letter spacing would put the glyph right of the middle.
      const ink = context.measureText("dx");
      context.fillText(
        "dx",
        textureWidth / 2 +
          (ink.actualBoundingBoxLeft - ink.actualBoundingBoxRight) / 2,
        textureHeight / 2 +
          (ink.actualBoundingBoxAscent - ink.actualBoundingBoxDescent) / 2,
      );
      const pixels = context.getImageData(
        0,
        0,
        textureWidth,
        textureHeight,
      ).data;
      const sourceBytesPerRow = textureWidth * 4;
      const bytesPerRow = Math.ceil(sourceBytesPerRow / 256) * 256;
      const glyphTexture = gpu.device.createTexture({
        size: [textureWidth, textureHeight],
        format: "rgba8unorm",
        usage: ["texture_binding", "copy_dst"],
      });
      gpu.gpu.queue.writeTexture(
        { texture: glyphTexture.gpu },
        pixels,
        { bytesPerRow, rowsPerImage: textureHeight },
        { width: textureWidth, height: textureHeight },
      );
      const shader = effect(gpu, shaderSource, {
        blend: "premultiplied",
        set: {
          glyphTexture,
          glyphSampler: sampler(gpu, {
            magFilter: "linear",
            minFilter: "linear",
          }),
          params: {
            time: 0,
            state: stateValue[state],
            pointer: [pointer.x, pointer.y],
            ink: markInk(mark),
            highlight: waterline(markInk(mark)),
          },
        },
      });
      // The page's appearance can change while the mark shows: Appearance
      // settings, the palette, or the system's light or dark setting.
      const recolor = () => {
        const ink = markInk(mark);
        shader.set({ params: { ink, highlight: waterline(ink) } });
      };
      const appearance = new MutationObserver(recolor);
      appearance.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-resolved-appearance", "data-palette"],
      });
      const systemScheme = window.matchMedia("(prefers-color-scheme: light)");
      systemScheme.addEventListener("change", recolor);
      const startedAt = performance.now();
      const loop = frameLoop(
        gpu,
        (frame) => {
          const elapsed = motionless()
            ? state === "loading"
              ? 10
              : 0
            : (performance.now() - startedAt) / 1000;
          shader.set({
            params: {
              time: elapsed,
              pointer: [pointer.x, pointer.y],
            },
          });
          frame.pass({ target, clear: [0, 0, 0, 0] }, (pass) =>
            pass.draw(shader),
          );
          canvas.dataset.ready = "true";
          if (mark !== null) mark.dataset.ready = "true";
        },
        { fps: motionless() ? 1 : 30 },
      );
      teardown = () => {
        appearance.disconnect();
        systemScheme.removeEventListener("change", recolor);
        loop.stop();
        glyphTexture.dispose();
        target.dispose();
        gpu.dispose();
      };
    } catch (error) {
      canvas.dataset.failed = "true";
      canvas.dataset.error =
        error instanceof Error ? error.message : "Unknown WebGPU error";
    }
  })();

  return () => {
    disposed = true;
    if (mark !== null) delete mark.dataset.ready;
    canvas.removeEventListener("pointermove", handlePointerMove);
    canvas.removeEventListener("pointerleave", handlePointerLeave);
    teardown();
  };
}
