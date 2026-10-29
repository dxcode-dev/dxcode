import * as React from "react";

/**
 * Below this width the page stacks: one view at a time under a view row,
 * and the title bar shows icons only (phones, iPad portrait).
 */
export const PANES_MIN_WIDTH = 1024;

const useMediaQuery = (query: string) => {
  const list = window.matchMedia(query);
  const subscribe = (notify: () => void) => {
    list.addEventListener("change", notify);
    return () => list.removeEventListener("change", notify);
  };
  const snapshot = () => list.matches;
  return React.useSyncExternalStore(subscribe, snapshot, snapshot);
};

export interface ThreadLayoutMode {
  /** One view at a time under a scrolling view row (phone, iPad portrait). */
  readonly stacked: boolean;
  /**
   * Icon-only title bar; the project and agent move to More Actions, and so
   * do the controls the bar has no room for.
   */
  readonly compact: boolean;
  /** Touch sizes: 44px bars and 36px buttons. */
  readonly coarse: boolean;
}

/**
 * How the Thread page lays out, from the viewport alone: panes
 * from 1024px up (desktop, iPad landscape), stacked below (phone, iPad
 * portrait), with touch sizes on a coarse pointer.
 */
export function useThreadLayoutMode(): ThreadLayoutMode {
  const stacked = useMediaQuery(`(max-width: ${PANES_MIN_WIDTH - 1}px)`);
  const coarse = useMediaQuery("(pointer: coarse)");
  return { stacked, compact: stacked, coarse };
}
