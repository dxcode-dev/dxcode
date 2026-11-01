import * as React from "react";

/**
 * Where the shown tab's toolbar renders: the end of its pane's tab strip, or
 * the end of the stacked layout's view row. Null when the tab is hidden or
 * there is no strip, so the toolbar renders in place.
 */
export const PaneToolbarSlotContext = React.createContext<HTMLElement | null>(
  null,
);

/**
 * Each open tab's slot for its own controls in the stacked view row, between
 * its label and close, as the Changes tab holds its range chooser. An external
 * store, so a slot appearing re-renders only the controls that portal into it,
 * never the views.
 */
export interface PaneTabSlots {
  readonly set: (tabId: string, node: HTMLElement | null) => void;
  readonly get: (tabId: string) => HTMLElement | null;
  readonly subscribe: (notify: () => void) => () => void;
}

export const createPaneTabSlots = (): PaneTabSlots => {
  const slots = new Map<string, HTMLElement>();
  const listeners = new Set<() => void>();
  return {
    set: (tabId, node) => {
      if ((slots.get(tabId) ?? null) === node) return;
      if (node === null) slots.delete(tabId);
      else slots.set(tabId, node);
      for (const notify of listeners) notify();
    },
    get: (tabId) => slots.get(tabId) ?? null,
    subscribe: (notify) => {
      listeners.add(notify);
      return () => listeners.delete(notify);
    },
  };
};

/** The shown tab's slots and id inside its panel; null in the panes. */
export const PaneTabSlotContext = React.createContext<{
  readonly slots: PaneTabSlots;
  readonly tabId: string;
} | null>(null);
