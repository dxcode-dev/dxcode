import * as React from "react";
import type { PaneSide } from "./pane-layout.js";

/** The tab being dragged; `dataTransfer` hides its data until the drop. */
export interface PaneDrag {
  readonly tab: string;
  readonly pane: string;
}

export const PANE_DRAG_MIME = "application/x-dx-pane-tab";

let current: PaneDrag | undefined;
const listeners = new Set<() => void>();

const notify = () => {
  for (const listener of listeners) listener();
};

export const startPaneDrag = (drag: PaneDrag) => {
  current = drag;
  notify();
};

export const endPaneDrag = () => {
  if (current === undefined) return;
  current = undefined;
  notify();
};

export const currentPaneDrag = () => current;

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The tab being dragged, or undefined; re-renders only at start and end. */
export const usePaneDrag = () =>
  React.useSyncExternalStore(subscribe, currentPaneDrag, currentPaneDrag);

export type DropZone = PaneSide | "center";

/** Outer quarter of an edge splits to that side; the middle joins. */
export const EDGE_SHARE = 0.25;

export const dropZoneFor = (
  rect: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number,
): DropZone => {
  if (rect.width <= 0 || rect.height <= 0) return "center";
  const x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;
  const distances: ReadonlyArray<readonly [DropZone, number]> = [
    ["left", x],
    ["right", 1 - x],
    ["top", y],
    ["bottom", 1 - y],
  ];
  let nearest: readonly [DropZone, number] = distances[0] as readonly [
    DropZone,
    number,
  ];
  for (const entry of distances) if (entry[1] < nearest[1]) nearest = entry;
  return nearest[1] < EDGE_SHARE ? nearest[0] : "center";
};

/** Where the translucent preview sits for a zone, as fractions of the body. */
export const dropPreviewBox = (zone: DropZone) => {
  switch (zone) {
    case "left":
      return { left: 0, top: 0, width: 50, height: 100 };
    case "right":
      return { left: 50, top: 0, width: 50, height: 100 };
    case "top":
      return { left: 0, top: 0, width: 100, height: 50 };
    case "bottom":
      return { left: 0, top: 50, width: 100, height: 50 };
    case "center":
      return { left: 0, top: 0, width: 100, height: 100 };
  }
};

/** Which tab slot the pointer is over in a strip, from the tabs' midpoints. */
export const dropIndexFor = (
  tabRects: ReadonlyArray<{ left: number; width: number }>,
  clientX: number,
) => {
  let index = 0;
  for (const rect of tabRects) {
    if (clientX > rect.left + rect.width / 2) index += 1;
    else break;
  }
  return index;
};
