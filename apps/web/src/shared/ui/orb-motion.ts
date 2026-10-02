const TAU = Math.PI * 2;
const RADIUS = 10.05;
const RING_SEGMENTS = 64;
const RIM_SEGMENTS = 96;
type Point = readonly [number, number, number];
type Rotation = { angle: number; speed: number; rest: number };

export interface OrbMotionOptions {
  readonly activityStatus: "idle" | "working";
  readonly reducedMotion: boolean;
}

const ring = (point: (angle: number) => Point, count: number) =>
  Array.from({ length: count + 1 }, (_, i) => point((i / count) * TAU));

// All three great circles and the rim lie on the same unit sphere. Rotate
// rigidly in 3D rather than interpolating projected paths (which shrinks them).
const gyro = [0, 1, 2].map((i) => {
  const angle = (i * TAU) / 3;
  return ring(
    (t) => [
      Math.cos(t) * Math.cos(angle) - Math.sin(t) * 0.48 * Math.sin(angle),
      Math.sin(t) * Math.sqrt(1 - 0.48 * 0.48),
      Math.cos(t) * Math.sin(angle) + Math.sin(t) * 0.48 * Math.cos(angle),
    ],
    RING_SEGMENTS,
  );
});
const rimPoints = ring((t) => [Math.cos(t), Math.sin(t), 0], RIM_SEGMENTS);

const moving = (rotation: Rotation) =>
  Math.abs(rotation.angle - rotation.rest) > 0.0001 ||
  Math.abs(rotation.speed) > 0.001;

const SHADING_BANDS = 8;
/**
 * Paths store coordinates in thousandths of a viewBox unit, scaled back by the
 * static `ORB_PATH_TRANSFORM`. Formatting integers is about five times cheaper
 * than `toFixed(3)` at the same precision, and it runs for every vertex of
 * every working Orb on every frame.
 */
export const ORB_PATH_TRANSFORM = "scale(0.001)";
export const ORB_PATH_STROKE_WIDTH = "700";
const coordinate = (point: Point) =>
  `${Math.round(point[0] * 1000)} ${Math.round(point[1] * 1000)}`;
const depthBand = (a: Point, b: Point) =>
  Math.round(
    Math.max(0, Math.min(1, (a[2] + b[2]) / 4 + 0.5)) * (SHADING_BANDS - 1),
  );

/**
 * Appends segments to per-band paths. Consecutive segments of one ring that
 * stay in a band continue the same polyline, so each vertex is formatted once
 * and the path the browser parses each frame is about 40% shorter. With round
 * caps and joins the stroke is visually equivalent to separate segments; only
 * antialiasing at shared vertices differs.
 */
const bandPaths = () => {
  const d = Array.from({ length: SHADING_BANDS }, () => "");
  const tail: Array<Point | undefined> = Array(SHADING_BANDS).fill(undefined);
  return {
    d,
    add(a: Point, b: Point) {
      const band = depthBand(a, b);
      d[band] +=
        tail[band] === a
          ? `L${coordinate(b)}`
          : `M${coordinate(a)}L${coordinate(b)}`;
      tail[band] = b;
    },
  };
};

// Batch equal-depth segments into a bounded set of compound paths. Eight
// shading bands preserve the small-icon depth cue without 288 DOM nodes.
const artwork = (innerAngle: number, outerAngle: number, mix: number) => {
  const rim = Array.from({ length: SHADING_BANDS }, (_, i) => ({
    id: `rim-depth-${i}`,
    d: "",
    opacity: 0.82 * (1 - mix) + mix * (0.45 + (0.55 * i) / (SHADING_BANDS - 1)),
  }));
  const core = Array.from({ length: SHADING_BANDS }, (_, i) => ({
    id: `core-depth-${i}`,
    d: "",
    opacity: 0.22 + (0.78 * i) / (SHADING_BANDS - 1),
  }));
  // Angles are constant within a frame: compute their trigonometry once.
  const innerCos = Math.cos(innerAngle);
  const innerSin = Math.sin(innerAngle);
  const outerCos = Math.cos(outerAngle);
  const outerSin = Math.sin(outerAngle);
  const project = (x: number, y: number, z: number): Point => [
    12 + RADIUS * (x * outerCos + z * outerSin),
    12 + RADIUS * y,
    -x * outerSin + z * outerCos,
  ];
  const rimPaths = bandPaths();
  const boundary = rimPoints.map(([x, y, z]) => project(x, y, z));
  for (let i = 0; i < RIM_SEGMENTS; i++)
    rimPaths.add(boundary[i], boundary[i + 1]);
  const corePaths = bandPaths();
  for (const ring of gyro) {
    const vertices = ring.map(([x, y, z]) =>
      // Rotate about Y by the inner angle, swap axes, then project.
      project(x * innerCos + z * innerSin, -(-x * innerSin + z * innerCos), y),
    );
    for (let i = 0; i < RING_SEGMENTS; i++)
      corePaths.add(vertices[i], vertices[i + 1]);
  }
  for (let i = 0; i < SHADING_BANDS; i++) {
    rim[i].d = rimPaths.d[i];
    core[i].d = corePaths.d[i];
  }
  return [...rim, ...core];
};

// Calculated once per module, shared by every idle icon and server rendering.
export const ORB_IDLE_ARTWORK = artwork(0, 0, 0);
export const ORB_IDLE_TRANSFORM =
  "translate(12 12) scale(1.000000) translate(-12 -12)";

/** Animates fixed React-owned paths; owns only browser subscriptions and RAF. */
export const mountOrbMotion = (group: SVGGElement) => {
  const document = group.ownerDocument;
  const view = document.defaultView;
  if (!view) return undefined;
  const window = view;
  const paths = Array.from(group.querySelectorAll("path"));
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  let options: OrbMotionOptions = {
    activityStatus: "idle",
    reducedMotion: false,
  };
  let target = 0;
  let mix = 0;
  let velocity = 0;
  let pulsePhase = 0;
  let last: number | undefined;
  let frame: number | undefined;
  let disposed = false;
  const inner: Rotation = { angle: 0, speed: 0, rest: 0 };
  const outer: Rotation = { angle: 0, speed: 0, rest: 0 };
  const reduced = () => options.reducedMotion || media.matches;
  const unsettled = () =>
    Math.abs(mix - target) > 0.0001 ||
    Math.abs(velocity) > 0.001 ||
    moving(inner) ||
    moving(outer);
  let painted = false;
  const paint = (
    frameArtwork: typeof ORB_IDLE_ARTWORK,
    transform: string,
    opacity: string,
  ) => {
    group.setAttribute("transform", transform);
    group.setAttribute("opacity", opacity);
    for (let i = 0; i < paths.length; i++) {
      paths[i].setAttribute("d", frameArtwork[i].d);
      // Band opacity changes only while working fades in or out.
      const opacity = String(frameArtwork[i].opacity);
      if (paths[i].getAttribute("opacity") !== opacity)
        paths[i].setAttribute("opacity", opacity);
    }
  };
  const draw = () => {
    const breath = reduced() ? 0 : mix * (0.5 - 0.5 * Math.cos(pulsePhase));
    paint(
      artwork(inner.angle, outer.angle, mix),
      `translate(12 12) scale(${(1 - 0.1 * breath).toFixed(6)}) translate(-12 -12)`,
      (1 - 0.35 * breath).toFixed(6),
    );
    painted = true;
  };
  const advance = (rotation: Rotation, speed: number, dt: number) => {
    if (target === 1) {
      rotation.speed += (speed - rotation.speed) * (1 - Math.exp(-7 * dt));
      rotation.angle += rotation.speed * dt;
    } else {
      // Critically damped angular spring preserves velocity on interruption.
      const w = 10;
      const y = rotation.angle - rotation.rest;
      const c = rotation.speed + w * y;
      const e = Math.exp(-w * dt);
      rotation.angle = rotation.rest + (y + c * dt) * e;
      rotation.speed = (rotation.speed - w * c * dt) * e;
      if (!moving(rotation)) {
        rotation.angle = rotation.rest;
        rotation.speed = 0;
      }
    }
  };
  function schedule() {
    if (
      !disposed &&
      frame === undefined &&
      !document.hidden &&
      !reduced() &&
      (target === 1 || unsettled())
    )
      frame = window.requestAnimationFrame(tick);
  }
  function tick(now: number) {
    frame = undefined;
    if (disposed) return;
    const dt = last === undefined ? 0 : Math.min((now - last) / 1000, 0.05);
    last = now;
    if (dt) {
      const w = 12;
      const y = mix - target;
      const c = velocity + w * y;
      const e = Math.exp(-w * dt);
      mix = target + (y + c * dt) * e;
      velocity = (velocity - w * c * dt) * e;
      if (Math.abs(mix - target) < 0.0001 && Math.abs(velocity) < 0.001) {
        mix = target;
        velocity = 0;
      }
      advance(inner, 1.55, dt);
      advance(outer, -0.9, dt);
      if (target === 0 && !unsettled()) {
        for (const rotation of [inner, outer]) {
          rotation.angle = 0;
          rotation.rest = 0;
        }
      }
      pulsePhase = (pulsePhase + (dt * TAU) / 1.8) % TAU;
    }
    draw();
    schedule();
    if (frame === undefined) last = undefined;
    syncSubscriptions();
  }
  const settleImmediately = () => {
    mix = target;
    velocity = 0;
    pulsePhase = 0;
    for (const rotation of [inner, outer]) {
      rotation.angle = 0;
      rotation.speed = 0;
      rotation.rest = 0;
    }
  };
  const cancel = () => {
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    frame = undefined;
    last = undefined;
  };
  const sync = () => {
    cancel();
    if (reduced()) settleImmediately();
    draw();
    syncSubscriptions();
    schedule();
  };
  let subscribed = false;
  function syncSubscriptions() {
    const needed =
      !disposed && !options.reducedMotion && (target === 1 || unsettled());
    if (needed === subscribed) return;
    subscribed = needed;
    if (needed) {
      media.addEventListener("change", sync);
      document.addEventListener("visibilitychange", sync);
    } else {
      media.removeEventListener("change", sync);
      document.removeEventListener("visibilitychange", sync);
    }
  }

  return {
    update(next: OrbMotionOptions) {
      if (
        disposed ||
        (next.activityStatus === options.activityStatus &&
          next.reducedMotion === options.reducedMotion)
      )
        return;
      const oldTarget = target;
      options = next;
      target = options.activityStatus === "working" ? 1 : 0;
      if (target === 0 && oldTarget === 1) {
        for (const rotation of [inner, outer])
          rotation.rest = Math.round(rotation.angle / TAU) * TAU;
      }
      if (reduced()) {
        sync();
        return;
      }
      syncSubscriptions();
      schedule();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancel();
      syncSubscriptions();
      // React Activity can detach refs while retaining their DOM. Leave the
      // declarative pose ready for a later idle reattach, without touching
      // icons that never animated.
      if (painted) paint(ORB_IDLE_ARTWORK, ORB_IDLE_TRANSFORM, "1.000000");
    },
  };
};
