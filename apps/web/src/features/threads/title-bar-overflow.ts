import * as React from "react";

/**
 * The title bar's optional controls, in the order they stay inline. When
 * the bar is too narrow for all of them, the last ones leave first and the
 * Thread menu lists them instead.
 */
export const TITLE_BAR_ITEMS = [
  "issues",
  "pulls",
  "ci",
  "listeners",
  "participants",
  "privacy",
] as const;
export type TitleBarItem = (typeof TITLE_BAR_ITEMS)[number];

const EMPTY: ReadonlySet<TitleBarItem> = new Set();

/** The width a control that has not been measured yet is assumed to take. */
const UNMEASURED_WIDTH = 36;

type Cleanup = () => void;

/**
 * Decides which optional controls fit a compact title bar. The bar, its
 * title group, its menu, and each control register through ref callbacks; a
 * ResizeObserver remeasures them, and `hidden` names the controls that must
 * leave the bar. Widths are cached while a control is visible, so a hidden
 * control comes back once the bar grows enough for it.
 */
export interface TitleBarOverflow {
  /** Ref for the bar; attach it only while the bar is compact. */
  readonly bar: (node: HTMLElement | null) => Cleanup | undefined;
  /** Ref for the title group, whose title keeps its CSS `min-width`. */
  readonly titleGroup: (node: HTMLElement | null) => Cleanup | undefined;
  /** Ref for the actions row, whose gap and the menu's width are fixed. */
  readonly actions: (node: HTMLElement | null) => Cleanup | undefined;
  /** Ref for one optional control's wrapper. */
  readonly item: (id: TitleBarItem) => (node: HTMLElement | null) => Cleanup;
  readonly subscribe: (notify: () => void) => Cleanup;
  readonly getSnapshot: () => ReadonlySet<TitleBarItem>;
}

const widthOf = (node: Element) => node.getBoundingClientRect().width;
const px = (value: string) => Number.parseFloat(value) || 0;

export function createTitleBarOverflow(): TitleBarOverflow {
  let bar: HTMLElement | null = null;
  let titleGroup: HTMLElement | null = null;
  let actions: HTMLElement | null = null;
  const items = new Map<TitleBarItem, HTMLElement>();
  const widths = new Map<TitleBarItem, number>();
  const itemRefs = new Map<
    TitleBarItem,
    (node: HTMLElement | null) => Cleanup
  >();
  const listeners = new Set<() => void>();
  let hidden: ReadonlySet<TitleBarItem> = EMPTY;
  const observer =
    typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver((entries) => {
          for (const { target } of entries)
            for (const [id, node] of items)
              if (node === target) {
                const width = widthOf(node);
                // A hidden control measures 0; keep its last visible width.
                if (width > 0) widths.set(id, width);
              }
          measure();
        });

  /** The title group's width once its title is squeezed to its minimum. */
  const titleGroupMinWidth = () => {
    if (titleGroup === null) return 0;
    const gap = px(getComputedStyle(titleGroup).columnGap);
    let total = 0;
    let count = 0;
    for (const child of titleGroup.children) {
      const style = getComputedStyle(child);
      if (style.display === "none") continue;
      total += child.classList.contains("thread-title")
        ? px(style.minWidth)
        : widthOf(child);
      count += 1;
    }
    return total + Math.max(0, count - 1) * gap;
  };

  /** What the actions row needs besides the optional controls. */
  const fixedActionsWidth = () => {
    if (actions === null) return 0;
    let total = 0;
    for (const child of actions.children) {
      if (child.hasAttribute("data-title-bar-item")) continue;
      if (child.classList.contains("thread-title-spacer")) continue;
      total += widthOf(child);
    }
    return total;
  };

  const measure = () => {
    let next: ReadonlySet<TitleBarItem> = EMPTY;
    if (bar?.isConnected) {
      const barStyle = getComputedStyle(bar);
      const available =
        bar.clientWidth -
        px(barStyle.paddingLeft) -
        px(barStyle.paddingRight) -
        px(barStyle.columnGap) -
        titleGroupMinWidth() -
        fixedActionsWidth();
      const gap =
        actions === null ? 0 : px(getComputedStyle(actions).columnGap);
      let used = 0;
      let overflowing = false;
      const set = new Set<TitleBarItem>();
      for (const id of TITLE_BAR_ITEMS) {
        if (!items.has(id)) continue;
        const width = widths.get(id) ?? UNMEASURED_WIDTH;
        if (!overflowing && used + width + gap <= available) {
          used += width + gap;
          continue;
        }
        overflowing = true;
        set.add(id);
      }
      if (set.size > 0) next = set;
    }
    if (next.size === hidden.size && [...next].every((id) => hidden.has(id)))
      return;
    hidden = next;
    for (const notify of listeners) notify();
  };

  const observe = (node: Element) => observer?.observe(node);
  const unobserve = (node: Element) => observer?.unobserve(node);

  return {
    bar: (node) => {
      bar = node;
      if (node === null) {
        measure();
        return undefined;
      }
      observe(node);
      measure();
      return () => {
        unobserve(node);
        if (bar === node) bar = null;
        measure();
      };
    },
    titleGroup: (node) => {
      titleGroup = node;
      if (node === null) return undefined;
      observe(node);
      for (const child of node.children) observe(child);
      measure();
      return () => {
        unobserve(node);
        for (const child of node.children) unobserve(child);
        if (titleGroup === node) titleGroup = null;
      };
    },
    actions: (node) => {
      actions = node;
      if (node === null) return undefined;
      for (const child of node.children)
        if (!child.hasAttribute("data-title-bar-item")) observe(child);
      measure();
      return () => {
        for (const child of node.children) unobserve(child);
        if (actions === node) actions = null;
      };
    },
    item: (id) => {
      let ref = itemRefs.get(id);
      if (ref === undefined) {
        ref = (node) => {
          if (node === null) return () => undefined;
          items.set(id, node);
          observe(node);
          const width = widthOf(node);
          if (width > 0) widths.set(id, width);
          measure();
          return () => {
            unobserve(node);
            if (items.get(id) === node) {
              items.delete(id);
              widths.delete(id);
            }
            measure();
          };
        };
        itemRefs.set(id, ref);
      }
      return ref;
    },
    subscribe: (notify) => {
      listeners.add(notify);
      return () => listeners.delete(notify);
    },
    getSnapshot: () => hidden,
  };
}

/** A ref callback for one optional control's slot, by its id. */
export type TitleBarItemRef = (
  id: TitleBarItem,
) => (node: HTMLElement | null) => Cleanup;

/** One title-bar overflow per bar, and the controls it hides right now. */
export function useTitleBarOverflow() {
  const [overflow] = React.useState(createTitleBarOverflow);
  const hidden = React.useSyncExternalStore(
    overflow.subscribe,
    overflow.getSnapshot,
    () => EMPTY,
  );
  return {
    barRef: overflow.bar,
    titleGroupRef: overflow.titleGroup,
    actionsRef: overflow.actions,
    itemRef: overflow.item,
    hidden,
  };
}
