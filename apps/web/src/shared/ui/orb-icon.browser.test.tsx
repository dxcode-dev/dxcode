import { Activity, act, createRef, StrictMode } from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { OrbIcon } from "./orb-icon.js";
import { mountOrbMotion } from "./orb-motion.js";

let frames: Map<number, FrameRequestCallback>;
let media: MediaQueryList;
let clock = 0;
let reduced = false;
let hidden = false;
let cleanup: (() => void) | undefined;
let root: Root | undefined;

beforeEach(() => {
  frames = new Map();
  clock = 0;
  reduced = false;
  hidden = false;
  let id = 0;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++id, callback);
    return id;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((frame) => {
    frames.delete(frame);
  });
  media = Object.assign(new EventTarget(), {
    get matches() {
      return reduced;
    },
    media: "(prefers-reduced-motion: reduce)",
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
  }) as MediaQueryList;
  Object.defineProperty(media, "matches", { get: () => reduced });
  vi.spyOn(window, "matchMedia").mockReturnValue(media);
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  cleanup?.();
  cleanup = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const step = (milliseconds = 1000 / 60) => {
  clock += milliseconds;
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(clock);
};
const advance = (count: number) => {
  for (let i = 0; i < count; i++) step();
};
const mount = () => {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(<OrbIcon />);
  const svg = container.querySelector("svg") as SVGSVGElement;
  document.body.append(svg);
  const group = svg.querySelector("[data-activity-artwork]") as SVGGElement;
  const motion = mountOrbMotion(group);
  if (!motion) throw new Error("Expected a browser renderer");
  cleanup = motion.dispose;
  return { svg, motion, group };
};

describe("rimmed gyroscope motion on the main thread", () => {
  it("preserves geometry on rapid reversals and repeated states, then stops all frames", () => {
    const { svg, motion } = mount();
    const idle = svg.innerHTML;
    motion.update({ activityStatus: "working", reducedMotion: false });
    advance(40);
    for (let i = 0; i < 8; i++) {
      const before = svg.innerHTML;
      const activityStatus = i % 2 === 0 ? "idle" : "working";
      motion.update({ activityStatus, reducedMotion: false });
      motion.update({ activityStatus, reducedMotion: false });
      expect(svg.innerHTML).toBe(before);
      expect(frames.size).toBe(1);
      advance(4);
    }
    motion.update({ activityStatus: "idle", reducedMotion: false });
    advance(300);
    expect(frames.size).toBe(0);
    expect(svg.innerHTML).toBe(idle);
    motion.update({ activityStatus: "working", reducedMotion: false });
    const restarted = svg.innerHTML;
    step(60_000);
    expect(svg.innerHTML).toBe(restarted);
    expect(frames.size).toBe(1);
  });

  it("pauses hidden tabs without time catch-up and resumes an interrupted settling", () => {
    const { svg, motion } = mount();
    motion.update({ activityStatus: "working", reducedMotion: false });
    advance(40);
    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    const paused = svg.innerHTML;
    expect(frames.size).toBe(0);
    step(60_000);
    motion.update({ activityStatus: "idle", reducedMotion: false });
    expect(frames.size).toBe(0);
    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    step();
    expect(svg.innerHTML).toBe(paused);
    advance(300);
    expect(frames.size).toBe(0);
  });

  it("honors live system and explicit reduced motion and releases all resources", () => {
    const removeMedia = vi.spyOn(media, "removeEventListener");
    const removeDocument = vi.spyOn(document, "removeEventListener");
    const { svg, group, motion } = mount();
    motion.update({ activityStatus: "working", reducedMotion: false });
    advance(40);
    reduced = true;
    media.dispatchEvent(new Event("change"));
    expect(frames.size).toBe(0);
    expect(group.getAttribute("opacity")).toBe("1.000000");
    const staticPose = svg.innerHTML;
    advance(30);
    expect(svg.innerHTML).toBe(staticPose);
    reduced = false;
    media.dispatchEvent(new Event("change"));
    expect(frames.size).toBe(1);
    motion.update({ activityStatus: "working", reducedMotion: true });
    expect(frames.size).toBe(0);
    motion.update({ activityStatus: "working", reducedMotion: false });
    expect(frames.size).toBe(1);
    motion.dispose();
    motion.dispose();
    expect(frames.size).toBe(0);
    expect(svg.querySelectorAll("path")).toHaveLength(16);
    expect(removeMedia).toHaveBeenCalledWith("change", expect.any(Function));
    expect(removeDocument).toHaveBeenCalledWith(
      "visibilitychange",
      expect.any(Function),
    );
    motion.update({ activityStatus: "working", reducedMotion: false });
    media.dispatchEvent(new Event("change"));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(frames.size).toBe(0);
  });
});

const canvasOf = (svg: Element | null | undefined) =>
  svg?.querySelector("foreignObject[data-orb-canvas]") as SVGElement | null;
const artworkOf = (svg: Element | null | undefined) =>
  svg?.querySelector("[data-activity-artwork]") as SVGGElement | null;
/** The worker committed a frame and the canvas replaced the SVG artwork. */
const canvasShown = (svg: Element | null | undefined) =>
  canvasOf(svg)?.style.visibility === "" &&
  artworkOf(svg)?.style.visibility === "hidden";
const idleMarkup = () => {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(<OrbIcon />);
  return artworkOf(container)?.outerHTML;
};
const waitFor = (check: () => void) =>
  vi.waitFor(check, { timeout: 5000, interval: 20 });

describe("OrbIcon working off the main thread", () => {
  it("animates a working Orb in the worker canvas, then hands back the idle SVG", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const ref = createRef<SVGSVGElement>();
    const render = (working: boolean) =>
      act(() =>
        root?.render(
          <StrictMode>
            <OrbIcon
              ref={ref}
              activityStatus={working ? "working" : "idle"}
              style={{ width: 96, height: 96 }}
            />
          </StrictMode>,
        ),
      );
    render(true);
    const svg = ref.current;
    const group = artworkOf(svg);
    // The canvas stays hidden until the worker has committed a frame.
    expect(canvasOf(svg)?.style.visibility).toBe("hidden");
    expect(group?.style.visibility).toBe("");
    await waitFor(() => expect(canvasShown(svg)).toBe(true));
    // No main-thread frames and no SVG writes while it works.
    expect(frames.size).toBe(0);
    expect(group?.outerHTML.replace(' style="visibility: hidden;"', "")).toBe(
      idleMarkup(),
    );
    expect(svg?.querySelectorAll("canvas")).toHaveLength(1);
    render(false);
    expect(ref.current).toBe(svg);
    expect(artworkOf(svg)).toBe(group);
    // It settles to the nearest full turn in the worker, then the SVG returns.
    await waitFor(() => expect(canvasOf(svg)).toBeNull());
    expect(group?.style.visibility).toBe("");
    expect(group?.outerHTML.replace(' style=""', "")).toBe(idleMarkup());
    render(true);
    await waitFor(() => expect(canvasShown(svg)).toBe(true));
    act(() => root?.unmount());
    root = undefined;
    expect(ref.current).toBeNull();
    expect(frames.size).toBe(0);
  });

  it("draws the Orb on the canvas in the SVG's color, with the unread dot cut away", async () => {
    const container = document.createElement("div");
    container.style.color = "rgb(0, 200, 0)";
    container.style.background = "rgb(0, 0, 0)";
    container.style.width = "96px";
    document.body.append(container);
    root = createRoot(container);
    act(() =>
      root?.render(
        <OrbIcon
          activityStatus="working"
          unread
          style={{ width: 96, height: 96, display: "block" }}
        />,
      ),
    );
    const svg = container.querySelector("svg");
    await waitFor(() => expect(canvasShown(svg)).toBe(true));
    if (!svg) throw new Error("Expected an Orb");
    const shot = await page.screenshot({ element: svg, save: false });
    const pixels = await new Promise<ImageData>((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d");
        if (!context) return reject(new Error("No 2D context"));
        context.drawImage(image, 0, 0);
        resolve(context.getImageData(0, 0, image.width, image.height));
      };
      image.onerror = reject;
      image.src = `data:image/png;base64,${shot}`;
    });
    // The test frame may be scaled; skip the edge pixels it resamples.
    const scale = pixels.width / 96;
    let green = 0;
    let other = 0;
    let insideCutaway = 0;
    for (let y = 2; y < pixels.height - 2; y++)
      for (let x = 2; x < pixels.width - 2; x++) {
        const i = (y * pixels.width + x) * 4;
        const [r, g, b] = [
          pixels.data[i],
          pixels.data[i + 1],
          pixels.data[i + 2],
        ];
        if (g > 40 && r < 20 && b < 20) {
          green++;
          // Inside the gap around the dot, past its own radius.
          const dx = x / scale / 4 - 21.1;
          const dy = y / scale / 4 - 4.8;
          const distance = Math.hypot(dx, dy);
          if (distance > 4.6 + 0.5 && distance < 4.6 + 1.7 - 0.5)
            insideCutaway++;
        } else if (r > 20 || b > 20) {
          other++;
        }
      }
    // Visible artwork in the inherited color, nothing in the cut-away.
    expect(green).toBeGreaterThan(500);
    expect(other).toBe(0);
    expect(insideCutaway).toBe(0);
  });

  it("stops drawing while the document is hidden and resumes when shown", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() =>
      root?.render(
        <OrbIcon
          activityStatus="working"
          style={{ width: 96, height: 96, display: "block" }}
        />,
      ),
    );
    const svg = container.querySelector("svg");
    if (!svg) throw new Error("Expected an Orb");
    await waitFor(() => expect(canvasShown(svg)).toBe(true));
    const pause = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms));
    const twoFrames = async () => {
      const first = await page.screenshot({ element: svg, save: false });
      await pause(300);
      return [first, await page.screenshot({ element: svg, save: false })];
    };
    const [moving, moved] = await twoFrames();
    expect(moved).not.toBe(moving);
    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    await pause(100);
    const [paused, stillPaused] = await twoFrames();
    expect(stillPaused).toBe(paused);
    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    await pause(100);
    const [resumed, movedAgain] = await twoFrames();
    expect(movedAgain).not.toBe(resumed);
  });

  it("keeps a static SVG pose and no canvas under reduced motion", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const render = (reducedMotion: boolean) =>
      act(() =>
        root?.render(
          <OrbIcon activityStatus="working" reducedMotion={reducedMotion} />,
        ),
      );
    render(true);
    const svg = container.querySelector("svg");
    const group = artworkOf(svg);
    expect(canvasOf(svg)).toBeNull();
    expect(frames.size).toBe(0);
    expect(group?.getAttribute("opacity")).toBe("1.000000");
    const staticPose = group?.innerHTML;
    expect(group?.outerHTML).not.toBe(idleMarkup());
    render(false);
    await waitFor(() => expect(canvasShown(svg)).toBe(true));
    // System reduced motion stops the canvas and restores the static pose.
    reduced = true;
    media.dispatchEvent(new Event("change"));
    expect(canvasOf(svg)).toBeNull();
    expect(group?.style.visibility).toBe("");
    expect(group?.innerHTML).toBe(staticPose);
    expect(frames.size).toBe(0);
  });

  it("restores declarative artwork when React Activity hides and reattaches it idle", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const render = (hidden: boolean, working: boolean) =>
      act(() =>
        root?.render(
          <Activity mode={hidden ? "hidden" : "visible"}>
            <OrbIcon activityStatus={working ? "working" : "idle"} />
          </Activity>,
        ),
      );
    render(false, false);
    const svg = container.querySelector("svg");
    const group = artworkOf(svg);
    render(false, true);
    await waitFor(() => expect(canvasShown(svg)).toBe(true));
    render(true, false);
    expect(canvasOf(svg)).toBeNull();
    render(false, false);
    expect(artworkOf(container)).toBe(group);
    expect(group?.style.visibility).toBe("");
    expect(group?.outerHTML.replace(' style=""', "")).toBe(idleMarkup());
    expect(frames.size).toBe(0);
    render(false, true);
    await waitFor(() => expect(canvasShown(svg)).toBe(true));
  });

  it("hydrates visible server artwork without duplicate paths or mismatches", async () => {
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(
      <OrbIcon activityStatus="working" />,
    );
    document.body.append(container);
    const group = artworkOf(container);
    const recover = vi.fn();
    await act(async () => {
      root = hydrateRoot(container, <OrbIcon activityStatus="working" />, {
        onRecoverableError: recover,
      });
    });
    expect(recover).not.toHaveBeenCalled();
    expect(artworkOf(container)).toBe(group);
    expect(container.querySelectorAll("path")).toHaveLength(16);
    await waitFor(() =>
      expect(canvasShown(container.querySelector("svg"))).toBe(true),
    );
    expect(container.querySelectorAll("path")).toHaveLength(16);
  });

  it("keeps 100 idle icons free of canvases and subscriptions, including after a working cycle", async () => {
    const addMedia = vi.spyOn(media, "addEventListener");
    const removeMedia = vi.spyOn(media, "removeEventListener");
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const ids = Array.from({ length: 100 }, (_, index) => `thread-${index}`);
    const render = (working: boolean) =>
      act(() =>
        root?.render(
          ids.map((id) => (
            <OrbIcon
              key={id}
              activityStatus={working && id === "thread-0" ? "working" : "idle"}
            />
          )),
        ),
      );
    render(false);
    expect(container.querySelectorAll("path")).toHaveLength(1600);
    expect(container.querySelectorAll("foreignObject")).toHaveLength(0);
    expect(frames.size).toBe(0);
    expect(addMedia).not.toHaveBeenCalled();
    render(true);
    expect(container.querySelectorAll("foreignObject")).toHaveLength(1);
    expect(addMedia).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(canvasShown(container.querySelector("svg"))).toBe(true),
    );
    render(false);
    await waitFor(() =>
      expect(container.querySelectorAll("foreignObject")).toHaveLength(0),
    );
    expect(removeMedia).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
    expect(container.querySelectorAll("path")).toHaveLength(1600);
  });

  it("forwards React 19 callback ref cleanup and initializes replacement refs", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const refCleanup = vi.fn();
    const firstRef = vi.fn(() => refCleanup);
    const secondRef = vi.fn((_node: SVGSVGElement | null) => {});
    act(() =>
      root?.render(<OrbIcon ref={firstRef} activityStatus="working" />),
    );
    expect(firstRef).toHaveBeenCalledTimes(1);
    const svg = container.querySelector("svg");
    const renderer = artworkOf(svg);
    await waitFor(() => expect(canvasShown(svg)).toBe(true));
    const canvas = canvasOf(svg);
    act(() =>
      root?.render(<OrbIcon ref={secondRef} activityStatus="working" />),
    );
    expect(refCleanup).toHaveBeenCalledTimes(1);
    expect(artworkOf(container)).toBe(renderer);
    // The running canvas, and so its angle and velocity, survive the swap.
    expect(canvasOf(svg)).toBe(canvas);
    expect(secondRef).toHaveBeenCalledWith(expect.any(SVGElement));
    act(() => root?.unmount());
    root = undefined;
    expect(secondRef.mock.calls.at(-1)?.[0]).toBeNull();
    expect(container.querySelectorAll("foreignObject")).toHaveLength(0);
    expect(frames.size).toBe(0);
  });
});
