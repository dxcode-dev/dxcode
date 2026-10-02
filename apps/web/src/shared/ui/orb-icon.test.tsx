// @vitest-environment happy-dom
import { Activity, act, createRef, StrictMode } from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  const motion = mountOrbMotion(svg.querySelector("g") as SVGGElement);
  if (!motion) throw new Error("Expected a browser renderer");
  cleanup = motion.dispose;
  return { svg, motion, group: svg.querySelector("g") as SVGGElement };
};
const paths = (svg: SVGSVGElement) =>
  [...svg.querySelectorAll("path")].map((path) => path.getAttribute("d"));

describe("rimmed gyroscope motion", () => {
  it("starts static with equal-radius rim and gyro, inheriting currentColor", () => {
    const { svg } = mount();
    expect(frames.size).toBe(0);
    expect(svg.querySelectorAll("path")).toHaveLength(16);
    expect(svg.getAttribute("stroke")).toBe("currentColor");
    expect(paths(svg).slice(0, 8).join("")).toContain("M22050 12000");
    expect(paths(svg).slice(8).join("")).toContain("M22050 12000");
    const idle = svg.innerHTML;
    advance(100);
    expect(svg.innerHTML).toBe(idle);
  });

  it("turns rim and inner rings together and breathes only inside the layout box", () => {
    const { svg, group, motion } = mount();
    const idle = paths(svg);
    motion.update({ activityStatus: "working", reducedMotion: false });
    expect(frames.size).toBe(1);
    advance(60);
    const working = paths(svg);
    expect(working.slice(0, 8)).not.toEqual(idle.slice(0, 8));
    expect(working.slice(8)).not.toEqual(idle.slice(8));
    let minScale = 1;
    let minOpacity = 1;
    for (let i = 0; i < 216; i++) {
      step();
      const scale = Number(
        group.getAttribute("transform")?.match(/scale\(([^)]+)\)/)?.[1],
      );
      const opacity = Number(group.getAttribute("opacity"));
      expect(scale).toBeGreaterThanOrEqual(0.9);
      expect(scale).toBeLessThanOrEqual(1);
      expect(opacity).toBeGreaterThanOrEqual(0.65);
      expect(opacity).toBeLessThanOrEqual(1);
      minScale = Math.min(minScale, scale);
      minOpacity = Math.min(minOpacity, opacity);
    }
    expect(minScale).toBeCloseTo(0.9, 3);
    expect(minOpacity).toBeCloseTo(0.65, 3);
    expect(svg.hasAttribute("width")).toBe(false);
    expect(svg.hasAttribute("height")).toBe(false);
  });

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

describe("OrbIcon compatibility", () => {
  it("preserves decorative defaults, opt-in labels, and SVG props", () => {
    const markup = renderToStaticMarkup(<OrbIcon />);
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain("<path");
    expect(markup).toContain("M22050 12000");
    const visible = renderToStaticMarkup(
      <OrbIcon
        aria-hidden={false}
        activityStatus="working"
        color="red"
        width={14}
        className="custom"
      />,
    );
    expect(visible).toContain('aria-label="Working"');
    expect(visible).toContain('role="img"');
    expect(visible).toContain('width="14"');
    expect(visible).toContain('color="red"');
    expect(visible).toContain('class="custom"');
    expect(
      renderToStaticMarkup(
        <OrbIcon aria-hidden="false" aria-label="Agent running" />,
      ),
    ).toContain('aria-label="Agent running"');
    expect(renderToStaticMarkup(<OrbIcon aria-hidden={false} />)).toContain(
      'aria-label="Idle"',
    );
  });

  it("retains the renderer across prop changes and cleans up in StrictMode", () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const ref = createRef<SVGSVGElement>();
    const render = (working: boolean) =>
      act(() =>
        root?.render(
          <StrictMode>
            <OrbIcon ref={ref} activityStatus={working ? "working" : "idle"} />
          </StrictMode>,
        ),
      );
    render(true);
    const svg = ref.current;
    const group = svg?.firstElementChild;
    expect(svg?.querySelectorAll("[data-activity-artwork]")).toHaveLength(1);
    expect(frames.size).toBe(1);
    advance(30);
    const before = svg?.innerHTML;
    render(false);
    expect(ref.current).toBe(svg);
    expect(svg?.firstElementChild).toBe(group);
    expect(svg?.innerHTML).toBe(before);
    render(true);
    expect(frames.size).toBe(1);
    act(() => root?.unmount());
    root = undefined;
    expect(ref.current).toBeNull();
    expect(frames.size).toBe(0);
  });

  it("restores declarative artwork when React Activity hides and reattaches it idle", () => {
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
    const group = container.querySelector("[data-activity-artwork]");
    const idle = group?.innerHTML;
    render(false, true);
    advance(30);
    expect(group?.innerHTML).not.toBe(idle);
    render(true, false);
    expect(frames.size).toBe(0);
    render(false, false);
    expect(container.querySelector("[data-activity-artwork]")).toBe(group);
    expect(group?.innerHTML).toBe(idle);
    expect(group?.getAttribute("opacity")).toBe("1.000000");
    expect(frames.size).toBe(0);
    render(false, true);
    expect(frames.size).toBe(1);
  });

  it("hydrates visible server artwork without duplicate paths or mismatches", async () => {
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(
      <OrbIcon activityStatus="working" />,
    );
    document.body.append(container);
    const group = container.querySelector("[data-activity-artwork]");
    const recover = vi.fn();
    await act(async () => {
      root = hydrateRoot(container, <OrbIcon activityStatus="working" />, {
        onRecoverableError: recover,
      });
    });
    expect(recover).not.toHaveBeenCalled();
    expect(container.querySelector("[data-activity-artwork]")).toBe(group);
    expect(container.querySelectorAll("path")).toHaveLength(16);
    expect(frames.size).toBe(1);
    advance(30);
    expect(container.querySelectorAll("path")).toHaveLength(16);
  });

  it("keeps 100 idle icons bounded and unsubscribed, including after a working cycle", () => {
    const addMedia = vi.spyOn(media, "addEventListener");
    const addDocument = vi.spyOn(document, "addEventListener");
    const removeMedia = vi.spyOn(media, "removeEventListener");
    const removeDocument = vi.spyOn(document, "removeEventListener");
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
    expect(frames.size).toBe(0);
    expect(addMedia).not.toHaveBeenCalled();
    expect(
      addDocument.mock.calls.filter(([type]) => type === "visibilitychange"),
    ).toHaveLength(0);
    render(true);
    expect(frames.size).toBe(1);
    expect(addMedia).toHaveBeenCalledTimes(1);
    advance(30);
    render(false);
    advance(300);
    expect(frames.size).toBe(0);
    expect(removeMedia).toHaveBeenCalledTimes(1);
    expect(removeDocument).toHaveBeenCalledWith(
      "visibilitychange",
      expect.any(Function),
    );
    expect(container.querySelectorAll("path")).toHaveLength(1600);
  });

  it("forwards React 19 callback ref cleanup and initializes replacement refs", () => {
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
    const renderer = container.querySelector("[data-activity-artwork]");
    advance(30);
    const before = renderer?.innerHTML;
    act(() =>
      root?.render(<OrbIcon ref={secondRef} activityStatus="working" />),
    );
    expect(refCleanup).toHaveBeenCalledTimes(1);
    expect(container.querySelector("[data-activity-artwork]")).toBe(renderer);
    expect(renderer?.innerHTML).toBe(before);
    expect(secondRef).toHaveBeenCalledWith(expect.any(SVGElement));
    expect(frames.size).toBe(1);
    act(() => root?.unmount());
    root = undefined;
    expect(secondRef.mock.calls.at(-1)?.[0]).toBeNull();
    expect(frames.size).toBe(0);
  });
});
