import { matchesKeyboardEvent } from "@tanstack/react-hotkeys";
import type {
  CommandContext,
  CommandId,
  CommandRegistry,
  CommandRuntime,
} from "./command-registry.js";

const SEQUENCE_TIMEOUT_MS = 700;

// An application surface (the remote Desktop) handles every key itself.
const EDITABLE_SELECTOR =
  "input, textarea, select, [role='textbox'], [role='application']";

// Controls that act on Enter or Space themselves.
const ACTIVATABLE_SELECTOR = [
  "a[href]",
  "button",
  "summary",
  "[role='button']",
  "[role='link']",
  "[role='checkbox']",
  "[role='switch']",
].join(", ");

// Widgets that also own the arrows, Home, End, paging, and letter typeahead.
const COMPOSITE_SELECTOR = [
  "menu",
  "menubar",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "listbox",
  "option",
  "combobox",
  "tablist",
  "tab",
  "radiogroup",
  "radio",
  "tree",
  "treeitem",
  "treegrid",
  "grid",
  "gridcell",
  "slider",
  "spinbutton",
  "scrollbar",
  "toolbar",
]
  .map((role) => `[role='${role}']`)
  .join(", ");

const ACTIVATION_KEYS = new Set(["Enter", " "]);
const COMPOSITE_KEYS = new Set([
  "Enter",
  " ",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

const eventOrigin = (event: KeyboardEvent) =>
  [...event.composedPath(), event.target].find(
    (target): target is Element => target instanceof Element,
  );

const isEditable = (origin: Element | undefined) => {
  if (origin === undefined) return false;
  if (origin.closest(EDITABLE_SELECTOR) !== null) return true;
  const contentEditable = origin.closest<HTMLElement>("[contenteditable]");
  return (
    contentEditable !== null &&
    contentEditable.getAttribute("contenteditable")?.toLowerCase() !== "false"
  );
};

/**
 * Whether the focused control acts on this unmodified key itself, so a
 * command must leave it alone: Enter on a button or link, or an arrow or
 * typeahead letter in a menu, tab list, or slider. Sidebar rows are the
 * command system's own controls.
 */
const isKeyOwnedByControl = (
  event: KeyboardEvent,
  origin: Element | undefined,
) => {
  if (origin === undefined || event.ctrlKey || event.altKey || event.metaKey)
    return false;
  if (origin.closest("[data-command-sidebar-item]") !== null) return false;
  if (origin.closest(COMPOSITE_SELECTOR) !== null)
    return COMPOSITE_KEYS.has(event.key) || /^[a-z0-9]$/i.test(event.key);
  return (
    origin.closest(ACTIVATABLE_SELECTOR) !== null &&
    ACTIVATION_KEYS.has(event.key)
  );
};

const surfaceExists = (id: CommandId, document: Document) => {
  // Enter opens the row that has focus, never one marked before focus moved.
  if (id === "sidebar.open-focused")
    return (
      document.activeElement?.closest("[data-command-focused='true']") != null
    );
  if (id === "sidebar.open-menu")
    return document.querySelector("[data-command-focused='true']") !== null;
  if (id === "sidebar.toggle-focus")
    return (
      document.querySelector("[data-command-action='toggle-sidebar']") !== null
    );
  if (id.startsWith("sidebar."))
    return document.querySelector("[data-command-surface='sidebar']") !== null;
  if (id === "threads.search")
    return (
      document.querySelector("[data-command-action='search-threads']") !== null
    );
  if (id === "thread.add-images")
    return (
      document.querySelector("[data-command-action='add-images']") !== null
    );
  if (id === "thread.focus-composer")
    return (
      document.querySelector("[data-command-target='thread-composer']") !== null
    );
  return true;
};

export interface CommandKeydownHandlerOptions {
  readonly registry: CommandRegistry;
  readonly runtime: CommandRuntime;
  readonly getContext: () => CommandContext;
  readonly document: Document;
  readonly now?: () => number;
}

/** One application-level listener owns chords, sequences, and modal precedence. */
export const createCommandKeydownHandler = ({
  registry,
  runtime,
  getContext,
  document,
  now = Date.now,
}: CommandKeydownHandlerOptions) => {
  let sequenceStartedAt = 0;
  let sequenceIndex = 0;
  return (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.repeat || event.isComposing) {
      sequenceIndex = 0;
      return;
    }
    const recording = registry.getActiveRecording();
    if (recording !== null) {
      // Recording only exists on the Keyboard Shortcuts screen; leaving that
      // context (or never being in it) discards the session instead of
      // swallowing keys app-wide.
      if (getContext() !== "keyboard-shortcuts") {
        registry.cancelRecording();
        sequenceIndex = 0;
      } else {
        sequenceIndex = 0;
        registry.recordKeyboardEvent(event);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    }
    const commands = registry.getCommands(getContext());
    const origin = eventOrigin(event);
    const targetHandlesKey =
      isEditable(origin) || isKeyOwnedByControl(event, origin);
    const modalOpen = document.querySelector(
      "[role='dialog']:not(.mobile-sidebar-drawer), [data-command-modal='true']",
    );
    if (targetHandlesKey || modalOpen !== null) {
      sequenceIndex = 0;
      return;
    }

    const menu = document.querySelector<HTMLElement>("[role='menu']");
    const dispatch = (id: CommandId) => {
      event.stopPropagation();
      if (menu !== null) {
        menu.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
            cancelable: true,
          }),
        );
      }
      registry.dispatch(id, runtime, getContext());
    };
    const sequence = commands.find(
      (command) => command.available && command.sequence !== undefined,
    );
    const plainKey =
      !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey
        ? event.key.toLowerCase()
        : "";
    if (sequence?.sequence !== undefined) {
      if (now() - sequenceStartedAt > SEQUENCE_TIMEOUT_MS) sequenceIndex = 0;
      // Sequence steps are normalized keys ("G"); compare case-insensitively
      // with the plain event key so overrides and defaults both match.
      if (plainKey === sequence.sequence[sequenceIndex]?.toLowerCase()) {
        sequenceStartedAt = now();
        sequenceIndex += 1;
        event.preventDefault();
        if (sequenceIndex === sequence.sequence.length) {
          sequenceIndex = 0;
          dispatch(sequence.id);
        }
        return;
      }
      sequenceIndex = 0;
    }

    const command = commands.find(
      (candidate) =>
        candidate.available &&
        (menu === null || candidate.scope === "global") &&
        surfaceExists(candidate.id, document) &&
        candidate.bindings.some((candidateBinding) =>
          matchesKeyboardEvent(event, candidateBinding, registry.platform),
        ),
    );
    if (command === undefined) return;
    event.preventDefault();
    dispatch(command.id);
  };
};
