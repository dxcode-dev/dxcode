import type { PointerEvent } from "react";

/**
 * Notes a press that opens the context menu: the focus it gives the row
 * must not mark it, or it would stay highlighted beside the selected
 * Thread after a menu action such as Open Source Thread.
 */
export function noteSidebarContextPress(event: PointerEvent<HTMLElement>) {
  if (event.button === 2 || (event.button === 0 && event.ctrlKey))
    event.currentTarget.dataset.contextPress = "";
}

/** Clears a context press that gave no focus: the row already had it. */
export function clearSidebarContextPress(element: HTMLElement) {
  delete element.dataset.contextPress;
}

/**
 * Marks one sidebar item as the command-navigation focus, so the arrow
 * keys, Enter, and M continue from it; a click marks it too. Focus from a
 * context-menu press only clears the previous mark.
 */
export function focusSidebarCommandItem(element: HTMLElement) {
  const items = document.querySelectorAll<HTMLElement>(
    "[data-command-sidebar-item]",
  );
  for (const item of items) delete item.dataset.commandFocused;
  if (element.dataset.contextPress !== undefined) {
    delete element.dataset.contextPress;
    return;
  }
  element.dataset.commandFocused = "true";
}
