import * as React from "react";

/** Below this width the page stacks: one view at a time under a view row. */
export const PANES_MIN_WIDTH = 1024;
/** Below this width the title bar shows icons only. */
export const COMPACT_TITLE_MAX_WIDTH = 767;

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
  /** Icon-only title bar; project, agent, and cost move to More Actions. */
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
  const compact = useMediaQuery(`(max-width: ${COMPACT_TITLE_MAX_WIDTH}px)`);
  const coarse = useMediaQuery("(pointer: coarse)");
  return { stacked, compact, coarse };
}
