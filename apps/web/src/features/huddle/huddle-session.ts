import { useSyncExternalStore } from "react";
import type { HuddleClient, HuddleScope } from "./huddle-client.js";
import { HUDDLE_MOCK } from "./huddle-flag.js";
import { MockHuddleClient } from "./mock-huddle-client.js";
import { RealtimeKitHuddleClient } from "./realtimekit-huddle-client.js";

/**
 * The tab's one Huddle: the call client plus how its window is shown. Both
 * live for the call, not for a route, so the huddle stays on screen while
 * you move around dx.
 */

// A development build opened with `?huddle-mock` keeps the stand-in call,
// since local `pnpm dev` has no RealtimeKit app.
export const huddleClient: HuddleClient = HUDDLE_MOCK
  ? new MockHuddleClient()
  : new RealtimeKitHuddleClient();

export type HuddleCorner =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

export type HuddleView = {
  /** Expanded fills the stage; docked is the small floating window. */
  readonly mode: "expanded" | "docked";
  readonly corner: HuddleCorner;
  /** Where the huddle belongs, for the dock's title and link back. */
  readonly place?: HuddlePlace;
  /** The browser's Picture-in-Picture window, when popped out. */
  readonly popout?: Window;
};

export type HuddlePlace = {
  readonly scope: HuddleScope;
  readonly name: string;
  /** The thread page that shows it; a Space opens on its own thread. */
  readonly threadId: string;
};

let view: HuddleView = { mode: "expanded", corner: "bottom-right" };
const viewListeners = new Set<() => void>();

const setView = (next: Partial<HuddleView>) => {
  view = { ...view, ...next };
  for (const listener of viewListeners) listener();
};

const subscribeView = (listener: () => void) => {
  viewListeners.add(listener);
  return () => {
    viewListeners.delete(listener);
  };
};

export const useHuddleCall = () =>
  useSyncExternalStore(
    huddleClient.subscribe,
    huddleClient.getSnapshot,
    huddleClient.getSnapshot,
  );

export const useHuddleView = () =>
  useSyncExternalStore(
    subscribeView,
    () => view,
    () => view,
  );

export const huddleView = {
  expand: () => setView({ mode: "expanded" }),
  dock: () => setView({ mode: "docked" }),
  moveTo: (corner: HuddleCorner) => setView({ corner }),
  setPopout: (popout: Window | undefined) => setView({ popout }),
};

export const joinHuddle = (
  place: HuddlePlace,
  options: { audio: boolean; video: boolean },
) => {
  view.popout?.close();
  setView({ place, mode: "expanded", popout: undefined });
  return huddleClient.join(place.scope, options);
};

export const leaveHuddle = () => {
  view.popout?.close();
  setView({ popout: undefined, mode: "expanded" });
  return huddleClient.leave();
};
