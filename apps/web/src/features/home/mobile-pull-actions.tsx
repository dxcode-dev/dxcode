import { Command, SquarePen } from "lucide-react";
import * as React from "react";
import { useCommandPaletteSurface } from "../../shared/commands/command-provider.js";
import { useNewThreadSurface } from "../../shared/new-thread-surface.js";
import "./mobile-home.css";

type PullStage = "palette" | "new-thread";

/** Travel, after resistance, that arms each action. */
const PALETTE_DISTANCE = 64;
const NEW_THREAD_DISTANCE = 136;
const MAXIMUM_DISTANCE = 200;
/** Finger travel before the gesture claims the touch from scrolling. */
const SLOP = 8;

const stageFor = (distance: number): PullStage | undefined =>
  distance >= NEW_THREAD_DISTANCE
    ? "new-thread"
    : distance >= PALETTE_DISTANCE
      ? "palette"
      : undefined;

// The list resists the finger more the further it is pulled.
const resisted = (travel: number) => Math.min(MAXIMUM_DISTANCE, travel * 0.55);

/** Listens until the returned function is called. */
const listen = <K extends keyof HTMLElementEventMap>(
  target: HTMLElement,
  type: K,
  handler: (event: HTMLElementEventMap[K]) => void,
  options?: AddEventListenerOptions,
) => {
  target.addEventListener(type, handler, options);
  return () => target.removeEventListener(type, handler, options);
};

const stagePresentation = {
  palette: { label: "Command Palette", Icon: Command },
  "new-thread": { label: "New Thread", Icon: SquarePen },
} as const;

/**
 * The phone home screen: pull down to open the command palette, and keep
 * pulling to start a new Thread.
 */
export function MobilePullActions({
  children,
}: {
  readonly children: React.ReactNode;
}) {
  const { openPalette } = useCommandPaletteSurface();
  const { openNewThread } = useNewThreadSurface();
  const [stage, setStage] = React.useState<PullStage>();
  // Outlives the listeners: they are attached again whenever the palette or
  // new-Thread actions change, which can happen in the middle of a pull.
  const gesture = React.useRef<{
    startY: number | undefined;
    pulling: boolean;
    current: PullStage | undefined;
  }>({ startY: undefined, pulling: false, current: undefined });
  const attach = (node: HTMLDivElement | null) => {
    if (node === null) return;
    const state = gesture.current;
    const show = (distance: number) => {
      node.style.setProperty("--pull-distance", `${distance}px`);
      const next = stageFor(distance);
      if (next === state.current) return;
      if (next !== undefined) navigator.vibrate?.(8);
      state.current = next;
      setStage(next);
    };
    const settle = () => {
      state.startY = undefined;
      state.pulling = false;
      node.removeAttribute("data-pulling");
      show(0);
    };
    const start = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (event.touches.length !== 1 || touch === undefined) {
        settle();
        return;
      }
      state.startY = touch.clientY;
    };
    const move = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (state.startY === undefined || touch === undefined) return;
      const travel = touch.clientY - state.startY;
      if (!state.pulling) {
        if (travel < -SLOP) state.startY = undefined;
        if (travel < SLOP) return;
        state.pulling = true;
        node.setAttribute("data-pulling", "");
      }
      event.preventDefault();
      show(resisted(Math.max(0, travel - SLOP)));
    };
    const release = () => {
      const action = state.pulling ? state.current : undefined;
      settle();
      if (action === "new-thread") openNewThread();
      else if (action === "palette") openPalette();
    };
    const stops = [
      listen(node, "touchstart", start, { passive: true }),
      // Not passive: a claimed pull stops the page from panning.
      listen(node, "touchmove", move, { passive: false }),
      listen(node, "touchend", release),
      listen(node, "touchcancel", settle),
    ];
    return () => {
      for (const stop of stops) stop();
    };
  };
  const presentation =
    stage === undefined ? undefined : stagePresentation[stage];
  return (
    <div className="mobile-home" ref={attach} data-pull-stage={stage}>
      {/* Shows the page can be pulled, as a sheet's grabber does. */}
      <span className="mobile-pull-handle" aria-hidden="true" />
      <div className="mobile-pull-indicator" aria-hidden="true">
        <span className="mobile-pull-line" />
        {presentation === undefined ? null : (
          <span className="mobile-pull-card" key={stage}>
            <presentation.Icon />
            <span>
              <strong>{presentation.label}</strong>
              <small>Release to open</small>
            </span>
          </span>
        )}
      </div>
      <div className="mobile-home-content">{children}</div>
    </div>
  );
}
