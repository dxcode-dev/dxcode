// Moves the working Orb's animation off the main thread. While an Orb works
// or settles, a canvas over its SVG artwork is drawn by one shared worker; the
// main thread only starts and stops it. Idle, reduced-motion, and browsers
// without OffscreenCanvas keep the SVG renderer.

import { mountOrbMotion, type OrbMotionOptions } from "./orb-motion.js";

export type OrbCanvasMessage =
  | {
      readonly type: "add";
      readonly id: number;
      readonly canvas: OffscreenCanvas;
      readonly color: string;
      readonly unread: boolean;
    }
  | {
      readonly type: "update";
      readonly id: number;
      readonly working?: boolean;
      readonly color?: string;
      readonly unread?: boolean;
      readonly visible?: boolean;
      readonly width?: number;
      readonly height?: number;
    }
  | { readonly type: "remove"; readonly id: number }
  | { readonly type: "page"; readonly hidden: boolean };

/** `shown`: the canvas has a committed frame. `settled`: it reached idle. */
export type OrbCanvasEvent = {
  readonly type: "shown" | "settled";
  readonly id: number;
};

export interface OrbRendererOptions extends OrbMotionOptions {
  readonly unread?: boolean;
}

interface Host {
  readonly svg: SVGSVGElement;
  shown(): void;
  settled(): void;
  failed(): void;
  /** The icon's square box: its CSS side, and the canvas side in pixels. */
  resize(cssSide: number, pixelSide: number): void;
  setVisible(visible: boolean): void;
}

interface Pool {
  readonly worker: Worker;
  readonly hosts: Map<number, Host>;
  readonly bySvg: Map<Element, Host>;
  readonly intersection: IntersectionObserver;
  readonly resize: ResizeObserver;
  readonly devicePixels: boolean;
}

const SVG = "http://www.w3.org/2000/svg";
let pool: Pool | undefined;
let unavailable = false;
let nextId = 0;

const supported = (window: Window & typeof globalThis) =>
  !unavailable &&
  typeof window.OffscreenCanvas === "function" &&
  typeof window.Worker === "function" &&
  typeof window.IntersectionObserver === "function" &&
  typeof window.ResizeObserver === "function" &&
  "transferControlToOffscreen" in window.HTMLCanvasElement.prototype;

const devicePixelBoxSupported = (window: Window & typeof globalThis) => {
  try {
    const probe = new window.ResizeObserver(() => {});
    probe.observe(window.document.documentElement, {
      box: "device-pixel-content-box",
    });
    probe.disconnect();
    return true;
  } catch {
    return false;
  }
};

const fail = () => {
  unavailable = true;
  const current = pool;
  pool = undefined;
  if (!current) return;
  current.intersection.disconnect();
  current.resize.disconnect();
  current.worker.terminate();
  for (const host of [...current.hosts.values()]) host.failed();
};

const sharedPool = (window: Window & typeof globalThis) => {
  if (pool) return pool;
  const document = window.document;
  // Vite bundles the worker as its own chunk only for this literal form.
  const worker = new Worker(
    new URL("./orb-canvas-worker.ts", import.meta.url),
    { type: "module", name: "orb-canvas" },
  );
  const hosts = new Map<number, Host>();
  const bySvg = new Map<Element, Host>();
  worker.addEventListener("message", (event: MessageEvent<OrbCanvasEvent>) => {
    const host = hosts.get(event.data.id);
    if (event.data.type === "shown") host?.shown();
    else host?.settled();
  });
  worker.addEventListener("error", fail);
  worker.postMessage({ type: "page", hidden: document.hidden });
  document.addEventListener("visibilitychange", () =>
    pool?.worker.postMessage({ type: "page", hidden: document.hidden }),
  );
  const devicePixels = devicePixelBoxSupported(window);
  pool = {
    worker,
    hosts,
    bySvg,
    devicePixels,
    // Orbs scrolled away, in a closed drawer, or not displayed stop drawing.
    intersection: new window.IntersectionObserver((entries) => {
      for (const entry of entries)
        bySvg.get(entry.target)?.setVisible(entry.isIntersecting);
    }),
    resize: new window.ResizeObserver((entries) => {
      for (const entry of entries) {
        const host = bySvg.get(entry.target);
        if (!host) continue;
        const css = entry.contentBoxSize[0];
        // A box that is not square centers the 24-unit viewBox in it, and
        // WebKit drops that offset for the canvas, so this Orb keeps the SVG.
        if (Math.abs(css.inlineSize - css.blockSize) > 0.5) {
          host.failed();
          continue;
        }
        const cssSide = Math.min(css.inlineSize, css.blockSize);
        const scaled = Math.round(cssSide * window.devicePixelRatio);
        const device = devicePixels
          ? entry.devicePixelContentBoxSize[0]
          : undefined;
        const exact = device && Math.min(device.inlineSize, device.blockSize);
        // The device-pixel box snaps exactly to the screen, but emulated
        // scale factors (DevTools, automation) leave it at 1x; there the
        // CSS size times the ratio matches what the SVG renders.
        const side =
          exact !== undefined && Math.abs(exact - scaled) <= 1 ? exact : scaled;
        host.resize(cssSide, side);
      }
    }),
  };
  return pool;
};

/**
 * Starts one Orb's canvas. It stays hidden until the worker has committed a
 * frame, then replaces the SVG artwork in one main-thread update, and the SVG
 * returns the same way once the worker reports the Orb settled at idle.
 */
const startCanvas = (
  window: Window & typeof globalThis,
  svg: SVGSVGElement,
  group: SVGGElement,
  unread: boolean,
  events: { settled(): void; failed(): void },
) => {
  const current = sharedPool(window);
  const document = window.document;
  const id = ++nextId;
  // WebKit paints a composited canvas in a foreignObject without the SVG's
  // viewBox scale (#1532). The frame is sized in CSS pixels and scaled back to
  // the 24-unit grid, so the scales cancel: the canvas covers the icon's box
  // whether or not an engine applies them.
  const frame = document.createElementNS(SVG, "foreignObject");
  frame.setAttribute("x", "0");
  frame.setAttribute("y", "0");
  frame.setAttribute("width", "24");
  frame.setAttribute("height", "24");
  frame.setAttribute("data-orb-canvas", "");
  frame.style.visibility = "hidden";
  frame.style.pointerEvents = "none";
  const canvas = document.createElement("canvas");
  canvas.width = 0;
  canvas.height = 0;
  canvas.style.display = "block";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  // A 1 ms color transition reports every change to the inherited color
  // (theme, hover, selection) without polling computed style.
  canvas.style.transition = "color 1ms";
  frame.append(canvas);
  svg.append(frame);
  const post = (message: OrbCanvasMessage, transfer?: Transferable[]) =>
    pool?.hosts.has(id) && pool.worker.postMessage(message, transfer ?? []);
  const color = () => window.getComputedStyle(svg).color;
  let lastColor = color();
  const syncColor = () => {
    const next = color();
    if (next === lastColor) return;
    lastColor = next;
    post({ type: "update", id, color: next });
  };
  canvas.addEventListener("transitionrun", syncColor);
  canvas.addEventListener("transitionend", syncColor);
  let disposed = false;
  const reveal = (canvasShown: boolean) => {
    frame.style.visibility = canvasShown ? "" : "hidden";
    group.style.visibility = canvasShown ? "hidden" : "";
  };
  const host: Host = {
    svg,
    shown: () => reveal(true),
    settled: events.settled,
    failed: () => {
      dispose();
      events.failed();
    },
    resize: (cssSide, pixelSide) => {
      if (cssSide > 0) {
        frame.setAttribute("width", String(cssSide));
        frame.setAttribute("height", String(cssSide));
        frame.setAttribute("transform", `scale(${24 / cssSide})`);
      }
      post({ type: "update", id, width: pixelSide, height: pixelSide });
    },
    setVisible: (visible) => post({ type: "update", id, visible }),
  };
  current.hosts.set(id, host);
  current.bySvg.set(svg, host);
  const offscreen = canvas.transferControlToOffscreen();
  post({ type: "add", id, canvas: offscreen, color: lastColor, unread }, [
    offscreen,
  ]);
  current.intersection.observe(svg);
  current.resize.observe(
    svg,
    current.devicePixels ? { box: "device-pixel-content-box" } : undefined,
  );
  function dispose() {
    if (disposed) return;
    disposed = true;
    post({ type: "remove", id });
    reveal(false);
    frame.remove();
    if (pool) {
      pool.hosts.delete(id);
      if (pool.bySvg.get(svg) === host) pool.bySvg.delete(svg);
      pool.intersection.unobserve(svg);
      pool.resize.unobserve(svg);
    }
  }
  return {
    setWorking: (working: boolean) => post({ type: "update", id, working }),
    setUnread: (next: boolean) => post({ type: "update", id, unread: next }),
    dispose,
  };
};

/**
 * Renders an Orb's React-owned SVG artwork. Static poses stay in the SVG;
 * animation runs in the shared canvas worker where the browser supports it,
 * and in the main-thread SVG renderer otherwise.
 */
export interface OrbRenderer {
  update(next: OrbRendererOptions): void;
  dispose(): void;
}

export const mountOrbRenderer = (
  group: SVGGElement,
): OrbRenderer | undefined => {
  const motion = mountOrbMotion(group);
  const window = group.ownerDocument.defaultView;
  const svg = group.ownerSVGElement;
  if (!motion || !window || !svg) return motion;
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  let options: OrbRendererOptions = {
    activityStatus: "idle",
    reducedMotion: false,
    unread: false,
  };
  let canvas: ReturnType<typeof startCanvas> | undefined;
  let staticStatus: OrbMotionOptions["activityStatus"] = "idle";
  let fallback = !supported(window);
  let disposed = false;
  let subscribed = false;
  const reduced = () => options.reducedMotion || media.matches;
  const showStatic = (activityStatus: OrbMotionOptions["activityStatus"]) => {
    if (staticStatus === activityStatus) return;
    staticStatus = activityStatus;
    motion.update({ activityStatus, reducedMotion: true });
  };
  const stopCanvas = () => {
    canvas?.dispose();
    canvas = undefined;
  };
  const route = () => {
    if (disposed) return;
    if (fallback) {
      stopCanvas();
      motion.update(options);
    } else if (reduced()) {
      stopCanvas();
      showStatic(options.activityStatus);
    } else {
      // The SVG keeps the idle pose under the canvas for the handoff back.
      showStatic("idle");
      const working = options.activityStatus === "working";
      if (working && !canvas) {
        try {
          canvas = startCanvas(window, svg, group, options.unread === true, {
            settled() {
              if (options.activityStatus === "working") return;
              stopCanvas();
              syncSubscriptions();
            },
            failed() {
              canvas = undefined;
              fallback = true;
              route();
            },
          });
        } catch {
          fail();
          fallback = true;
          route();
          return;
        }
      }
      canvas?.setWorking(working);
    }
    syncSubscriptions();
  };
  function syncSubscriptions() {
    const needed =
      !disposed &&
      !fallback &&
      !options.reducedMotion &&
      (options.activityStatus === "working" || canvas !== undefined);
    if (needed === subscribed) return;
    subscribed = needed;
    if (needed) media.addEventListener("change", route);
    else media.removeEventListener("change", route);
  }
  return {
    update(next: OrbRendererOptions) {
      if (disposed) return;
      const unread = next.unread === true;
      if (unread !== (options.unread === true)) canvas?.setUnread(unread);
      const changed =
        next.activityStatus !== options.activityStatus ||
        next.reducedMotion !== options.reducedMotion;
      options = { ...next, unread };
      if (changed) route();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stopCanvas();
      syncSubscriptions();
      motion.dispose();
    },
  };
};
