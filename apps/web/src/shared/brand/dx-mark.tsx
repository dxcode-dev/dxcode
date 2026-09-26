import "@fontsource/dm-sans/700-italic.css";
import { useCallback } from "react";
import { effect, frameLoop, init, sampler, surface } from "vgpu";
import shaderSource from "./dx-mark.wgsl?raw";
import "./brand.css";

export type DxMarkState =
  | "idle"
  | "loading"
  | "thinking"
  | "working"
  | "complete"
  | "error";

const stateValue: Record<DxMarkState, number> = {
  idle: 0,
  thinking: 1,
  working: 2,
  complete: 3,
  error: 4,
  loading: 5,
};

/** Creates the offscreen canvas used to rasterize the canonical dx glyph. */
const makeGlyphCanvas = (width: number, height: number) => {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
};

/** Connects one mark canvas to WebGPU and returns its complete teardown routine. */
function mountDxMark(
  canvas: HTMLCanvasElement,
  state: DxMarkState,
  interactive: boolean,
) {
  let disposed = false;
  let teardown: () => void = () => undefined;
  const pointer = { x: 0.5, y: 0.5 };
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
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
      context.fillText(
        "dx",
        textureWidth / 2,
        textureHeight / 2 + fontSize * 0.03,
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
          },
        },
      });
      const startedAt = performance.now();
      const loop = frameLoop(
        gpu,
        (frame) => {
          const elapsed = reducedMotion.matches
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
        },
        { fps: reducedMotion.matches ? 1 : 30 },
      );
      teardown = () => {
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
    canvas.removeEventListener("pointermove", handlePointerMove);
    canvas.removeEventListener("pointerleave", handlePointerLeave);
    teardown();
  };
}

/** Renders the canonical animated dx mark for a product lifecycle state. */
export function DxMark({
  state = "idle",
  label = "dx",
  className = "",
  interactive = false,
}: {
  readonly state?: DxMarkState;
  readonly label?: string;
  readonly className?: string;
  readonly interactive?: boolean;
}) {
  const ref = useCallback(
    (canvas: HTMLCanvasElement | null) =>
      canvas === null ? undefined : mountDxMark(canvas, state, interactive),
    [interactive, state],
  );
  return (
    <span
      className={`dx-brand-mark ${className}`.trim()}
      data-state={state}
      role="img"
      aria-label={label}
    >
      <span className="dx-brand-mark-fallback" aria-hidden="true">
        dx
      </span>
      <canvas key={state} ref={ref} />
    </span>
  );
}
