import * as React from "react";

const escapeSnapshot = () => 0;

/**
 * Closes a settings surface on Escape, unless a dialog, menu, or shortcut
 * recording on top of it takes the key. `closeSettings` navigates, so an
 * unsaved-changes guard on the page still asks first.
 */
export const useCloseSettingsOnEscape = (closeSettings: () => void) => {
  const subscribe = (_onStoreChange: () => void) => {
    const close = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        document.querySelector(
          "[role='dialog'], [role='menu'], .shortcut-recording",
        ) !== null
      )
        return;
      closeSettings();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  };
  React.useSyncExternalStore(subscribe, escapeSnapshot, escapeSnapshot);
};
