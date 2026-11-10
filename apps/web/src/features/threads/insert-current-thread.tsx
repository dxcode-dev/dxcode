import type * as React from "react";
import { useSyncExternalStore } from "react";
import { ShortcutKeycaps } from "../../shared/commands/shortcut-keycaps.js";
import { absoluteThreadUrl } from "../../shared/thread-url.js";

const shortcutSnapshot = () => 0;

/** Control+I on every platform, as the keycaps show. */
const isInsertShortcut = (event: KeyboardEvent) =>
  !event.defaultPrevented &&
  !event.repeat &&
  !event.isComposing &&
  event.ctrlKey &&
  !event.shiftKey &&
  !event.metaKey &&
  !event.altKey &&
  event.key.toLowerCase() === "i";

/**
 * `text` put at the prompt's caret, or over its selection, with a space
 * between it and any word either side; and where the caret goes after it.
 */
const insertAtSelection = (
  prompt: string,
  selection: { readonly start: number; readonly end: number },
  text: string,
) => {
  const before = prompt.slice(0, selection.start);
  const after = prompt.slice(selection.end);
  const inserted = `${before === "" || /\s$/.test(before) ? "" : " "}${text}${/^\s/.test(after) ? "" : " "}`;
  return {
    value: `${before}${inserted}${after}`,
    caret: before.length + inserted.length,
  };
};

/**
 * The New Thread dialog's header action, shown only over an open Thread: it
 * puts that Thread's URL in the prompt at the caret. Control+I does the
 * same while the dialog is open; phones show no keycaps.
 */
export function InsertCurrentThreadButton({
  threadId,
  prompt,
  textareaRef,
  disabled,
  onPromptChange,
}: {
  readonly threadId: string;
  readonly prompt: string;
  readonly textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  readonly disabled: boolean;
  readonly onPromptChange: (value: string) => void;
}) {
  const insert = () => {
    const textarea = textareaRef.current;
    const end = textarea?.selectionEnd ?? prompt.length;
    const { value, caret } = insertAtSelection(
      prompt,
      { start: textarea?.selectionStart ?? end, end },
      absoluteThreadUrl(threadId, window.location.href),
    );
    onPromptChange(value);
    requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(caret, caret);
    });
  };
  const onShortcut = (event: KeyboardEvent) => {
    if (disabled || !isInsertShortcut(event)) return;
    event.preventDefault();
    insert();
  };
  const subscribe = (_onStoreChange: () => void) => {
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  };
  useSyncExternalStore(subscribe, shortcutSnapshot, shortcutSnapshot);
  return (
    <button
      type="button"
      className="new-thread-header-action"
      aria-label="Insert Current Thread"
      aria-keyshortcuts="Control+I"
      disabled={disabled}
      onClick={insert}
    >
      Insert Current Thread <ShortcutKeycaps keycaps={["⌃", "I"]} />
    </button>
  );
}
