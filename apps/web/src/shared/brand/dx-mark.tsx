import "@fontsource/dm-sans/700-italic.css";
import "./brand.css";

export type DxMarkState =
  | "idle"
  | "loading"
  | "thinking"
  | "working"
  | "complete"
  | "error";

// A loading mark usually shows while the app's own code downloads and runs;
// its renderer would compete with that work. It animates only if the wait
// outlasts this, and shows its static text until then.
const LOADING_RENDERER_DELAY_MS = 3_000;

/**
 * Runs `callback` after `delay` and then once the browser is idle, so the
 * WebGPU renderer (about 45 KB gzip) never competes with the page it
 * decorates; the text fallback shows until then. Returns a cancel function.
 */
const afterDelayWhenIdle = (callback: () => void, delay: number) => {
  let idle: number | undefined;
  const timer = window.setTimeout(() => {
    if (typeof window.requestIdleCallback === "function")
      idle = window.requestIdleCallback(callback);
    else callback();
  }, delay);
  return () => {
    window.clearTimeout(timer);
    if (idle !== undefined) window.cancelIdleCallback(idle);
  };
};

/** Mounts the WebGPU mark on its canvas once its renderer has loaded. */
function attachDxMark(
  canvas: HTMLCanvasElement,
  state: DxMarkState,
  interactive: boolean,
  still: boolean,
) {
  let teardown: (() => void) | undefined;
  let disposed = false;
  const cancelIdle = afterDelayWhenIdle(
    () => {
      void import("./dx-mark-renderer.js").then(
        ({ mountDxMark }) => {
          if (!disposed)
            teardown = mountDxMark(canvas, state, interactive, still);
        },
        (error: unknown) => {
          canvas.dataset.failed = "true";
          canvas.dataset.error =
            error instanceof Error ? error.message : "Renderer unavailable";
        },
      );
    },
    state === "loading" ? LOADING_RENDERER_DELAY_MS : 0,
  );
  return () => {
    disposed = true;
    cancelIdle();
    teardown?.();
  };
}

/** Renders the canonical animated dx mark for a product lifecycle state. */
export function DxMark({
  state = "idle",
  label = "dx",
  className = "",
  interactive = false,
  still = false,
}: {
  readonly state?: DxMarkState;
  readonly label?: string;
  readonly className?: string;
  readonly interactive?: boolean;
  /** Draws one static frame, as for reduced motion. */
  readonly still?: boolean;
}) {
  const ref = (canvas: HTMLCanvasElement | null) =>
    canvas === null
      ? undefined
      : attachDxMark(canvas, state, interactive, still);
  return (
    <span
      className={`dx-brand-mark ${className}`.trim()}
      data-state={state}
      data-motion={still ? "still" : undefined}
      role="img"
      aria-label={label}
    >
      <span className="dx-brand-mark-fallback" aria-hidden="true">
        dx
      </span>
      <canvas key={`${state}:${still}`} ref={ref} />
    </span>
  );
}
