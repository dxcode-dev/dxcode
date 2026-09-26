// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCommandKeydownHandler } from "./command-dispatcher.js";
import {
  type CommandRuntime,
  createCommandRegistry,
} from "./command-registry.js";

const runtime = () =>
  ({
    navigateHome: vi.fn(),
    openCommandPalette: vi.fn(),
    openThreadSearch: vi.fn(),
    openKeymap: vi.fn(),
    navigateToProjects: vi.fn(),
    navigateToNewThread: vi.fn(),
    navigateToSettings: vi.fn(),
    navigateToWorkspaceSettings: vi.fn(),
    navigateToAppearanceSettings: vi.fn(),
    navigateToKeyboardShortcuts: vi.fn(),
    focusThreadComposer: vi.fn(),
    focusKeyboardShortcutSearch: vi.fn(),
    restoreKeyboardShortcutDefaults: vi.fn(),
    copyCurrentUrl: vi.fn(),
    goBack: vi.fn(),
    goForward: vi.fn(),
    toggleAndFocusSidebar: vi.fn(),
    moveSidebarSelection: vi.fn(),
    openFocusedSidebarItem: vi.fn(),
    switchThread: vi.fn(),
    openFocusedThreadMenu: vi.fn(),
    addThreadImages: vi.fn(),
  }) satisfies CommandRuntime;

const key = (value: string, init: KeyboardEventInit = {}) =>
  new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: value,
    ...init,
  });

afterEach(() => document.body.replaceChildren());

describe("central command dispatcher", () => {
  it("dispatches bounded g g, but not in editable targets, on repeat, or after timeout", () => {
    const actions = runtime();
    let time = 1;
    const handler = createCommandKeydownHandler({
      registry: createCommandRegistry({ platform: "linux" }),
      runtime: actions,
      getContext: () => "app",
      document,
      now: () => time,
    });
    handler(key("g"));
    handler(key("g"));
    expect(actions.navigateHome).toHaveBeenCalledOnce();

    const input = document.body.appendChild(document.createElement("input"));
    input.addEventListener("keydown", handler);
    input.dispatchEvent(key("g"));
    expect(actions.navigateHome).toHaveBeenCalledOnce();
    handler(key("g", { repeat: true }));
    time = 1_000;
    handler(key("g"));
    expect(actions.navigateHome).toHaveBeenCalledOnce();
  });

  it("records g g for home without dispatching any shortcut while recording", () => {
    const actions = runtime();
    const registry = createCommandRegistry({ platform: "linux" });
    const handler = createCommandKeydownHandler({
      registry,
      runtime: actions,
      getContext: () => "keyboard-shortcuts",
      document,
    });
    const recorded: unknown[] = [];
    registry.startRecording("navigation.home", {
      onRecorded: (proposal) => recorded.push(proposal),
    });
    handler(key("g"));
    expect(actions.navigateHome).not.toHaveBeenCalled();
    expect(registry.getActiveRecording()).toMatchObject({
      commandId: "navigation.home",
      steps: ["G"],
    });
    handler(key("g"));
    expect(actions.navigateHome).not.toHaveBeenCalled();
    expect(actions.openKeymap).not.toHaveBeenCalled();
    expect(registry.getActiveRecording()).toBeNull();
    expect(recorded).toEqual([{ kind: "sequence", steps: ["G", "G"] }]);
  });

  it("keeps every other shortcut inert while recording and swallows the keys", () => {
    const actions = runtime();
    const registry = createCommandRegistry({ platform: "linux" });
    const handler = createCommandKeydownHandler({
      registry,
      runtime: actions,
      getContext: () => "keyboard-shortcuts",
      document,
    });
    const recorded: unknown[] = [];
    registry.startRecording("command-palette.open", {
      onRecorded: (proposal) => recorded.push(proposal),
    });
    const questionMark = key("?", { shiftKey: true, code: "Slash" });
    handler(questionMark);
    expect(questionMark.defaultPrevented).toBe(true);
    expect(actions.openKeymap).not.toHaveBeenCalled();
    // A modified chord completes the recording as a single-hotkey proposal.
    expect(registry.getActiveRecording()).toBeNull();
    expect(recorded).toEqual([{ kind: "hotkey", hotkey: "Shift+?" }]);

    // While a sequence recording is mid-way, other shortcuts stay inert.
    registry.startRecording("navigation.home", {
      onRecorded: (proposal) => recorded.push(proposal),
    });
    handler(key("g"));
    const palette = key("o", { ctrlKey: true });
    handler(palette);
    expect(palette.defaultPrevented).toBe(true);
    expect(actions.openCommandPalette).not.toHaveBeenCalled();
    expect(registry.getActiveRecording()).toBeNull();
    expect(recorded[1]).toEqual({ kind: "hotkey", hotkey: "Mod+O" });
  });

  it("discards the recording session outside the shortcuts screen", () => {
    const actions = runtime();
    const registry = createCommandRegistry({ platform: "linux" });
    let context: "app" | "keyboard-shortcuts" = "keyboard-shortcuts";
    const handler = createCommandKeydownHandler({
      registry,
      runtime: actions,
      getContext: () => context,
      document,
    });
    registry.startRecording("navigation.home");
    context = "app";
    handler(key("g"));
    expect(registry.getActiveRecording()).toBeNull();
    // The key is not swallowed after cancelling: it keeps its normal meaning.
    handler(key("g"));
    expect(actions.navigateHome).toHaveBeenCalledOnce();
  });

  it("cancels recording on Escape and proposes clearing on Backspace", () => {
    const actions = runtime();
    const registry = createCommandRegistry({ platform: "linux" });
    const handler = createCommandKeydownHandler({
      registry,
      runtime: actions,
      getContext: () => "keyboard-shortcuts",
      document,
    });
    const cancelled = vi.fn();
    registry.startRecording("navigation.home", { onCancelled: cancelled });
    const escapeEvent = key("Escape");
    handler(escapeEvent);
    expect(escapeEvent.defaultPrevented).toBe(true);
    expect(cancelled).toHaveBeenCalledOnce();
    expect(registry.getActiveRecording()).toBeNull();

    const cleared: unknown[] = [];
    registry.startRecording("navigation.home", {
      onRecorded: (proposal) => cleared.push(proposal),
    });
    const backspace = key("Backspace");
    handler(backspace);
    expect(backspace.defaultPrevented).toBe(true);
    expect(cleared).toEqual([{ kind: "clear" }]);
  });

  it("cancels a pending sequence when focus moves through an editable target", () => {
    const actions = runtime();
    const handler = createCommandKeydownHandler({
      registry: createCommandRegistry({ platform: "linux" }),
      runtime: actions,
      getContext: () => "app",
      document,
    });
    handler(key("g"));
    const input = document.body.appendChild(document.createElement("input"));
    input.addEventListener("keydown", handler);
    input.dispatchEvent(key("g"));
    handler(key("g"));
    expect(actions.navigateHome).not.toHaveBeenCalled();
    handler(key("g"));
    expect(actions.navigateHome).toHaveBeenCalledOnce();
  });

  it("opens global commands from a menu before its key handler consumes the event", () => {
    const actions = runtime();
    const handler = createCommandKeydownHandler({
      registry: createCommandRegistry({ platform: "linux" }),
      runtime: actions,
      getContext: () => "app",
      document,
    });
    const menu = document.body.appendChild(document.createElement("div"));
    menu.setAttribute("role", "menu");
    const trigger = document.body.appendChild(document.createElement("button"));
    trigger.focus();
    const close = vi.fn();
    menu.addEventListener("keydown", (event) => {
      if (event.key === "Escape") close();
      event.stopPropagation();
    });
    window.addEventListener("keydown", handler, true);
    try {
      menu.dispatchEvent(key("?", { shiftKey: true, code: "Slash" }));
      expect(close).toHaveBeenCalledOnce();
      expect(actions.openKeymap).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener("keydown", handler, true);
    }
  });

  it("supports alternatives once and yields to open modals, IME, and absent surfaces", () => {
    const actions = runtime();
    const handler = createCommandKeydownHandler({
      registry: createCommandRegistry({ platform: "linux" }),
      runtime: actions,
      getContext: () => "app",
      document,
    });
    handler(key("k", { ctrlKey: true }));
    expect(actions.openCommandPalette).toHaveBeenCalledOnce();
    handler(key("ArrowDown"));
    expect(actions.moveSidebarSelection).not.toHaveBeenCalled();

    const dialog = document.body.appendChild(document.createElement("div"));
    dialog.setAttribute("role", "dialog");
    handler(key("o", { ctrlKey: true }));
    handler(key("o", { ctrlKey: true, isComposing: true }));
    expect(actions.openCommandPalette).toHaveBeenCalledOnce();
  });

  it("honors explicit overrides instead of retaining catalog alternatives", () => {
    const registry = createCommandRegistry({ platform: "linux" });
    expect(
      registry.setBinding("command-palette.open", "Mod+Shift+P"),
    ).toMatchObject({ ok: true });
    const actions = runtime();
    const handler = createCommandKeydownHandler({
      registry,
      runtime: actions,
      getContext: () => "app",
      document,
    });
    handler(key("k", { ctrlKey: true }));
    handler(key("p", { ctrlKey: true, shiftKey: true }));
    expect(actions.openCommandPalette).toHaveBeenCalledOnce();
  });
});
