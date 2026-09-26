import { matchesKeyboardEvent } from "@tanstack/react-hotkeys";
import type {
  CommandContext,
  CommandId,
  CommandRegistry,
  CommandRuntime,
} from "./command-registry.js";

const SEQUENCE_TIMEOUT_MS = 700;

const EDITABLE_SELECTOR = "input, textarea, select, [role='textbox']";

const isEditableEvent = (event: KeyboardEvent) => {
  const origin = [...event.composedPath(), event.target].find(
    (target): target is Element => target instanceof Element,
  );
  if (origin === undefined) return false;
  if (origin.closest(EDITABLE_SELECTOR) !== null) return true;
  const contentEditable = origin.closest<HTMLElement>("[contenteditable]");
  return (
    contentEditable !== null &&
    contentEditable.getAttribute("contenteditable")?.toLowerCase() !== "false"
  );
};

const surfaceExists = (id: CommandId, document: Document) => {
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
    const editable = isEditableEvent(event);
    const modalOpen = document.querySelector(
      "[role='dialog']:not(.mobile-sidebar-drawer), [data-command-modal='true']",
    );
    if (editable || modalOpen !== null) {
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
