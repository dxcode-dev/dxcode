import { type Hotkey, matchesKeyboardEvent } from "@tanstack/react-hotkeys";
import type {
  CommandContext,
  CommandId,
  CommandPlatform,
  CommandRegistry,
  CommandRuntime,
} from "./command-registry.js";
import {
  commandContextFromPath,
  getBrowserCommandRegistry,
  sharedDefaultPartner,
} from "./command-registry.js";
import { physicalKeyEvent } from "./physical-key.js";

const SEQUENCE_TIMEOUT_MS = 700;

// Inputs that take typed text; a checkbox or button input is a control.
const TEXT_INPUT_SELECTOR =
  "input:not([type='checkbox'], [type='radio'], [type='button'], [type='submit'], [type='reset'], [type='image'], [type='file'], [type='color'], [type='range'], [type='hidden'])";
// An application surface (the remote Desktop, the Terminal) handles every key
// itself.
const APPLICATION_SELECTOR = "[role='application']";
const EDITABLE_SELECTOR = `${TEXT_INPUT_SELECTOR}, textarea, select, [role='textbox'], ${APPLICATION_SELECTOR}`;

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

/**
 * Whether an open Thread's messages take a key the sidebar shares with them
 * (Up and Down by default): they do unless focus is in the sidebar, as in
 * the reference keymap.
 */
const messagesTakeArrows = (document: Document) => {
  const sidebar = document.querySelector("[data-command-surface='sidebar']");
  if (sidebar?.contains(document.activeElement) === true) return false;
  return transcriptShown(document);
};
const transcriptShown = (document: Document) =>
  [...document.querySelectorAll(".transcript-viewport")].some((viewport) =>
    viewport.checkVisibility(),
  );
/**
 * Whether the key belongs to an application surface wherever focus sits in
 * it, shadow roots included.
 */
const ownedByApplication = (event: KeyboardEvent) =>
  event
    .composedPath()
    .some(
      (target) =>
        target instanceof Element && target.matches(APPLICATION_SELECTOR),
    );

// The command surfaces: the palette, the keymap, and Search Threads.
const COMMAND_SURFACE_SELECTOR = "[role='dialog'].command-surface-dialog";
const MODAL_SELECTOR =
  "[role='dialog']:not(.mobile-sidebar-drawer), [data-command-modal='true']";

/** The open modals: none, only command surfaces, or another dialog. */
const openModals = (document: Document) => {
  const modals = [...document.querySelectorAll(MODAL_SELECTOR)];
  if (modals.length === 0) return "none";
  return modals.every((modal) => modal.matches(COMMAND_SURFACE_SELECTOR))
    ? "command-surface"
    : "other";
};

const MAC_TEXT_CONTROL_KEYS = new Set("abdefhknoptvy");
const TEXT_NAVIGATION_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Backspace",
  "Delete",
  "Tab",
]);

/**
 * Whether a text field edits text with this chord itself: moving the caret
 * or deleting by word, select all, clipboard, undo, rich-text marks in an
 * editor, and macOS's Control+letter editing keys.
 */
const isTextEditingChord = (
  event: KeyboardEvent,
  origin: Element | undefined,
  platform: CommandPlatform,
) => {
  if (TEXT_NAVIGATION_KEYS.has(event.key)) return true;
  const key = physicalKeyEvent(event).key.toLowerCase();
  const mod = platform === "mac" ? event.metaKey : event.ctrlKey;
  if (
    mod &&
    !event.altKey &&
    key.length === 1 &&
    (event.shiftKey ? "vz" : "acvxyz").includes(key)
  )
    return true;
  if (
    mod &&
    !event.altKey &&
    !event.shiftKey &&
    "biu".includes(key) &&
    key.length === 1 &&
    origin?.closest("[contenteditable]") != null
  )
    return true;
  return (
    platform === "mac" &&
    event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey &&
    MAC_TEXT_CONTROL_KEYS.has(key)
  );
};

const MESSAGE_COMMANDS = new Set<CommandId>([
  "thread.previous-user-message",
  "thread.next-user-message",
  "thread.previous-message",
  "thread.next-message",
]);

const surfaceExists = (id: CommandId, document: Document) => {
  if (MESSAGE_COMMANDS.has(id)) return transcriptShown(document);
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

/** Whether `binding` matches, reading a non-Latin letter as its physical key. */
export const matchesShortcut = (
  event: KeyboardEvent,
  binding: Hotkey,
  platform: CommandPlatform,
) => {
  if (matchesKeyboardEvent(event, binding, platform)) return true;
  const physical = physicalKeyEvent(event);
  return (
    physical !== event && matchesKeyboardEvent(physical, binding, platform)
  );
};

/**
 * Closes the open command surfaces (palette, keymap, Search Threads) before a
 * command run from one of them, as Escape would.
 */
const closeCommandSurfaces = (document: Document) => {
  for (const surface of document.querySelectorAll(COMMAND_SURFACE_SELECTOR))
    surface.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
};

/**
 * The command a chord runs from where plain keys belong to something else:
 * a text field, or an open command surface. Only commands marked
 * `fromTextFields`, only chords with Ctrl, Alt, or Cmd, and never a chord the
 * field edits text with or an application surface's key.
 */
const textFieldCommand = (
  event: KeyboardEvent,
  registry: CommandRegistry,
  context: CommandContext,
  document: Document,
) => {
  if (!event.ctrlKey && !event.altKey && !event.metaKey) return undefined;
  if (ownedByApplication(event)) return undefined;
  const origin = eventOrigin(event);
  if (
    isEditable(origin) &&
    isTextEditingChord(event, origin, registry.platform)
  )
    return undefined;
  return registry
    .getCommands(context)
    .find(
      (command) =>
        command.available &&
        command.fromTextFields === true &&
        surfaceExists(command.id, document) &&
        command.bindings.some((binding) =>
          matchesShortcut(event, binding, registry.platform),
        ),
    );
};

/**
 * Whether this key press in a text field runs an app command, such as
 * Alt+Enter for a new Thread. An editor that marks every Enter handled
 * (ProseMirror) lets these pass instead, so the app runs them.
 */
export const runsAppCommandFromTextField = (event: KeyboardEvent) =>
  !event.defaultPrevented &&
  !event.repeat &&
  !event.isComposing &&
  textFieldCommand(
    event,
    getBrowserCommandRegistry(),
    commandContextFromPath(window.location.pathname),
    document,
  ) !== undefined;

/**
 * Runs Ctrl, Alt, and Cmd chords a text field left unhandled, such as
 * Alt+Enter for a new Thread from the composer. Listens in the bubble phase,
 * after the field: a key the field acts on (an editor's Cmd+K link) stays
 * its own.
 */
export const createTextFieldCommandHandler = ({
  registry,
  runtime,
  getContext,
  document,
}: CommandKeydownHandlerOptions) => {
  return (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.repeat || event.isComposing) return;
    if (registry.getActiveRecording() !== null) return;
    if (!isEditable(eventOrigin(event))) return;
    if (openModals(document) !== "none") return;
    const command = textFieldCommand(event, registry, getContext(), document);
    if (command === undefined) return;
    event.preventDefault();
    registry.dispatch(command.id, runtime, getContext());
  };
};

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
    const modals = openModals(document);
    // A command surface yields to commands meant to run from anywhere, and
    // closes first; its own keys (typing, arrows, Enter) stay its own.
    if (modals === "command-surface") {
      sequenceIndex = 0;
      const command = textFieldCommand(event, registry, getContext(), document);
      if (command === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      closeCommandSurfaces(document);
      registry.dispatch(command.id, runtime, getContext());
      return;
    }
    // Text fields get their chords first; the bubble-phase handler runs the
    // ones they leave.
    const targetHandlesKey =
      isEditable(origin) || isKeyOwnedByControl(event, origin);
    if (targetHandlesKey || modals !== "none") {
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
        ? physicalKeyEvent(event).key.toLowerCase()
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

    const matches = (binding: Hotkey) =>
      matchesShortcut(event, binding, registry.platform);
    // A key a sidebar command shares with its message partner (only their
    // shared default) goes to one of them by focus; every other key, and
    // either command once rebound, has one owner and is unaffected.
    const yieldsSharedKey = (candidate: (typeof commands)[number]) => {
      const partnerId = sharedDefaultPartner(candidate.id);
      if (partnerId === undefined) return false;
      const partner = commands.find((command) => command.id === partnerId);
      if (partner === undefined || !partner.bindings.some(matches))
        return false;
      const messagesWin = messagesTakeArrows(document);
      return MESSAGE_COMMANDS.has(candidate.id) ? !messagesWin : messagesWin;
    };
    const command = commands.find(
      (candidate) =>
        candidate.available &&
        (menu === null || candidate.scope === "global") &&
        surfaceExists(candidate.id, document) &&
        candidate.bindings.some(matches) &&
        !yieldsSharedKey(candidate),
    );
    if (command === undefined) return;
    event.preventDefault();
    dispatch(command.id);
  };
};
