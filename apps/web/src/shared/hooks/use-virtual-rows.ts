import {
  elementScroll,
  observeElementOffset,
  observeElementRect,
  type VirtualItem,
  Virtualizer,
} from "@tanstack/react-virtual";
import { useLayoutEffect, useState, useSyncExternalStore } from "react";

export interface VirtualRowsOptions {
  /** The element that scrolls; null until its ref callback runs. */
  readonly scrollElement: HTMLElement | null;
  readonly count: number;
  /** Each row's height in px, or the first guess when `measure` is on. */
  readonly rowHeight: number;
  /** Rows drawn beyond each edge of the viewport. */
  readonly overscan?: number;
}

export interface VirtualRowsWindow {
  /** The rows to draw, each with its index and top offset in px. */
  readonly rows: ReadonlyArray<VirtualItem>;
  /** The height in px of every row together. */
  readonly totalSize: number;
}

const EMPTY: VirtualRowsWindow = { rows: [], totalSize: 0 };

/**
 * One TanStack Virtual instance and the window it last published. The
 * instance mutates in place, so React reads only `snapshot`, which becomes a
 * new object whenever the drawn rows or the total height change.
 */
function createVirtualRows() {
  const listeners = new Set<() => void>();
  let snapshot = EMPTY;
  let scrollElement: HTMLElement | null = null;
  const publish = () => {
    const rows = virtualizer.getVirtualItems();
    const totalSize = virtualizer.getTotalSize();
    if (rows === snapshot.rows && totalSize === snapshot.totalSize) return;
    snapshot = { rows, totalSize };
    for (const listener of listeners) listener();
  };
  const options = (next: VirtualRowsOptions) => ({
    count: next.count,
    getScrollElement: () => scrollElement,
    estimateSize: () => next.rowHeight,
    overscan: next.overscan ?? 8,
    observeElementRect,
    observeElementOffset,
    scrollToFn: elementScroll,
    onChange: publish,
  });
  const virtualizer = new Virtualizer<HTMLElement, Element>(
    options({ scrollElement: null, count: 0, rowHeight: 0 }),
  );
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot: () => snapshot,
    mount: () => virtualizer._didMount(),
    update: (next: VirtualRowsOptions) => {
      scrollElement = next.scrollElement;
      virtualizer.setOptions(options(next));
      virtualizer._willUpdate();
      publish();
    },
    /** A row's ref callback: the row needs `data-index`; resizes re-measure it. */
    measure: (element: Element | null) => virtualizer.measureElement(element),
  };
}

/**
 * Windows a long list inside a scroll box with TanStack Virtual: it returns
 * only the rows in view (plus `overscan`) and the full height to reserve.
 * The external system is the scroll element's DOM scroll position and size,
 * which TanStack Virtual observes with scroll listeners and a
 * ResizeObserver; the layout effects attach and detach those observers.
 * Rows of varying height pass `measure` as their ref with `data-index`.
 * The instance never reaches render, so callers compile under the React
 * Compiler, unlike `useVirtualizer`.
 */
export function useVirtualRows({
  scrollElement,
  count,
  rowHeight,
  overscan,
}: VirtualRowsOptions): VirtualRowsWindow & {
  readonly measure: (element: Element | null) => void;
} {
  const [store] = useState(createVirtualRows);
  useLayoutEffect(() => store.mount(), [store]);
  useLayoutEffect(() => {
    store.update({ scrollElement, count, rowHeight, overscan });
  }, [store, scrollElement, count, rowHeight, overscan]);
  const visible = useSyncExternalStore(
    store.subscribe,
    store.snapshot,
    store.snapshot,
  );
  return {
    rows: visible.rows,
    totalSize: visible.totalSize,
    measure: store.measure,
  };
}

/**
 * Keeps a scroll box at its end while `pinned`: whenever `end` (the content
 * height in px) grows, it sets the element's DOM `scrollTop` to it before the
 * browser paints. A log or terminal calls it with the reader's "at the
 * bottom" state.
 */
export function useScrollPinnedToEnd(
  element: HTMLElement | null,
  pinned: boolean,
  end: number,
) {
  useLayoutEffect(() => {
    if (element === null || !pinned) return;
    element.scrollTo({ top: end });
  }, [element, pinned, end]);
}
