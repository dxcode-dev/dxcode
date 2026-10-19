import * as React from "react";

// A primary pointer that is coarse and cannot hover means a touch device
// typing on an on-screen keyboard, whatever the viewport width.
const touchKeyboardQuery = "(hover: none) and (pointer: coarse)";

const subscribe = (notify: () => void) => {
  const query = window.matchMedia(touchKeyboardQuery);
  query.addEventListener("change", notify);
  return () => query.removeEventListener("change", notify);
};
const typesOnTouchKeyboard = () =>
  window.matchMedia(touchKeyboardQuery).matches;

/**
 * Enter key behavior for a prompt composer's textarea. On a hardware
 * keyboard, Enter sends and Shift+Enter adds a line. On a touch device, Enter
 * adds a line and the send button sends; Cmd/Ctrl+Enter also sends, because
 * a keyboard attached to a tablet cannot be told apart from the on-screen
 * one. IME composition never sends.
 */
export function useComposerEnterKey() {
  const touch = React.useSyncExternalStore(
    subscribe,
    typesOnTouchKeyboard,
    () => false,
  );
  return {
    enterKeyHint: touch ? ("enter" as const) : undefined,
    /** Whether this key press sends the composer's prompt. */
    sends: (event: React.KeyboardEvent<HTMLTextAreaElement>) =>
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing &&
      (!touch || event.metaKey || event.ctrlKey),
  };
}
