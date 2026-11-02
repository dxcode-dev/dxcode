/// <reference lib="webworker" />
// Draws every animating Orb off the main thread. Each Orb's canvas was
// transferred here, so its frames reach the compositor without a main-thread
// task, style recalculation, or layout. One loop serves every Orb.

import type { OrbCanvasEvent, OrbCanvasMessage } from "./orb-canvas.js";
import { drawOrb } from "./orb-canvas-draw.js";
import { createOrbPhysics } from "./orb-motion.js";

declare const self: DedicatedWorkerGlobalScope;

interface Orb {
  readonly canvas: OffscreenCanvas;
  readonly context: OffscreenCanvasRenderingContext2D;
  readonly physics: ReturnType<typeof createOrbPhysics>;
  color: string;
  unread: boolean;
  visible: boolean;
  last: number | undefined;
  /** Frames drawn since this run started; the first is shown one frame later. */
  drawn: number;
}

const orbs = new Map<number, Orb>();
let pageHidden = false;
let frame: number | undefined;
let tickCount = 0;
// Group opacity applies to the composed artwork, as SVG `opacity` does, so
// each frame strokes into this layer before blending it onto the Orb.
let layer: OffscreenCanvas | undefined;

const post = (event: OrbCanvasEvent) => self.postMessage(event);
const running = (orb: Orb) =>
  orb.visible &&
  orb.canvas.width > 0 &&
  orb.canvas.height > 0 &&
  orb.physics.animating();

// Workers without requestAnimationFrame fall back to a 60 Hz timer.
const nativeFrames = typeof self.requestAnimationFrame === "function";
const requestFrame = (callback: (now: number) => void): number =>
  nativeFrames
    ? self.requestAnimationFrame(callback)
    : self.setTimeout(() => callback(performance.now()), 1000 / 60);
const cancelFrame = (id: number) =>
  nativeFrames ? self.cancelAnimationFrame(id) : self.clearTimeout(id);

function schedule() {
  if (frame !== undefined || pageHidden) return;
  for (const orb of orbs.values())
    if (running(orb)) {
      frame = requestFrame(tick);
      return;
    }
}

const draw = (orb: Orb) => {
  layer ??= new OffscreenCanvas(orb.canvas.width, orb.canvas.height);
  drawOrb(orb.context, layer, orb.physics.pose(false), orb.color, orb.unread);
};

function tick(now: number) {
  frame = undefined;
  tickCount++;
  let count = 0;
  for (const orb of orbs.values()) if (running(orb)) count++;
  // Many working Orbs on screen at once share a lower frame rate.
  const stride = count <= 4 ? 1 : count <= 12 ? 2 : 3;
  if (tickCount % stride === 0)
    for (const [id, orb] of orbs) {
      if (!running(orb)) continue;
      const dt =
        orb.last === undefined ? 0 : Math.min((now - orb.last) / 1000, 0.1);
      orb.last = now;
      if (dt) orb.physics.step(dt);
      draw(orb);
      // The first frame was committed with the previous task, so the main
      // thread can now show the canvas in place of the SVG without a gap.
      if (++orb.drawn === 2) post({ type: "shown", id });
      if (!orb.physics.animating()) {
        orb.last = undefined;
        post({ type: "settled", id });
      }
    }
  schedule();
}

const pause = (orb: Orb) => {
  // Paused Orbs resume where they stopped, without elapsed-time catch-up.
  orb.last = undefined;
};

self.onmessage = (event: MessageEvent<OrbCanvasMessage>) => {
  const message = event.data;
  switch (message.type) {
    case "add": {
      const context = message.canvas.getContext("2d");
      if (!context) return;
      const physics = createOrbPhysics();
      physics.setWorking(true);
      orbs.set(message.id, {
        canvas: message.canvas,
        context,
        physics,
        color: message.color,
        unread: message.unread,
        visible: false,
        last: undefined,
        drawn: 0,
      });
      break;
    }
    case "update": {
      const orb = orbs.get(message.id);
      if (!orb) return;
      if (message.working !== undefined) {
        orb.physics.setWorking(message.working);
        if (message.working && orb.drawn === 0) orb.last = undefined;
      }
      if (message.color !== undefined) orb.color = message.color;
      if (message.unread !== undefined) orb.unread = message.unread;
      if (message.visible !== undefined) {
        orb.visible = message.visible;
        if (!orb.visible) pause(orb);
      }
      if (message.width !== undefined && message.height !== undefined) {
        orb.canvas.width = message.width;
        orb.canvas.height = message.height;
      }
      // Redraw now so a resize, color, or dot change does not wait a frame.
      if (orb.drawn > 0 && orb.canvas.width > 0 && orb.canvas.height > 0)
        draw(orb);
      break;
    }
    case "remove":
      orbs.delete(message.id);
      break;
    case "page":
      pageHidden = message.hidden;
      if (pageHidden) {
        if (frame !== undefined) cancelFrame(frame);
        frame = undefined;
        for (const orb of orbs.values()) pause(orb);
      }
      break;
  }
  schedule();
};
