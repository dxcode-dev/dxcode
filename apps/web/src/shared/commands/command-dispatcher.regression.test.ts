// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCommandKeydownHandler } from "./command-dispatcher.js";
import {
  type CommandRuntime,
  commandDefinitions,
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

// A real `Shift+/` keypress: browsers deliver the shifted glyph `?` on `event.key`
// while the physical key reports `event.code === "Slash"`.
const shiftSlash = (init: KeyboardEventInit = {}) =>
  key("?", { shiftKey: true, code: "Slash", ...init });

const platforms = ["mac", "windows", "linux"] as const;

afterEach(() => document.body.replaceChildren());

describe("command dispatcher shifted-punctuation regression", () => {
  it("dispatches keymap.open when the user presses Shift+/ (the on-screen shortcut)", () => {
    for (const platform of platforms) {
      const actions = runtime();
      const handler = createCommandKeydownHandler({
        registry: createCommandRegistry({ platform }),
        runtime: actions,
        getContext: () => "app",
        document,
      });
      handler(shiftSlash());
      expect(actions.openKeymap).toHaveBeenCalledOnce();
      expect(actions.navigateHome).not.toHaveBeenCalled();
    }
  });

  it("dispatches the Alt+Shift+/ alternative on every platform, including the macOS ¿ glyph", () => {
    for (const platform of platforms) {
      const actions = runtime();
      const handler = createCommandKeydownHandler({
        registry: createCommandRegistry({ platform }),
        runtime: actions,
        getContext: () => "app",
        document,
      });
      // Windows/Linux: Alt does not transform the glyph; macOS: Option maps to ¿.
      const glyph = platform === "mac" ? "¿" : "?";
      handler(
        key(glyph, {
          altKey: true,
          shiftKey: true,
          code: "Slash",
        }),
      );
      expect(actions.openKeymap).toHaveBeenCalledOnce();
    }
  });

  for (const [surface, markup, selector] of [
    ["native input", "<input>", "input"],
    ["native textarea", "<textarea></textarea>", "textarea"],
    [
      "nested contenteditable",
      '<div contenteditable="true"><span data-target>draft</span></div>',
      "[data-target]",
    ],
    [
      "nested ARIA textbox",
      '<div role="textbox"><span data-target>draft</span></div>',
      "[data-target]",
    ],
    [
      "Pierre editor textarea",
      '<div class="pierre-editor"><textarea data-target></textarea></div>',
      "[data-target]",
    ],
    [
      "composer textarea",
      '<form class="agent-composer"><textarea data-target></textarea></form>',
      "[data-target]",
    ],
    [
      "edit dialog field",
      '<div role="dialog"><input data-target></div>',
      "[data-target]",
    ],
  ] as const) {
    it(`leaves printable shortcut variants available in ${surface}`, () => {
      document.body.innerHTML = markup;
      const target = document.querySelector<HTMLElement>(selector);
      if (target === null) throw new Error(`Missing ${surface} fixture`);
      const actions = runtime();
      const handler = createCommandKeydownHandler({
        registry: createCommandRegistry({ platform: "linux" }),
        runtime: actions,
        getContext: () => "app",
        document,
      });
      target.addEventListener("keydown", handler);
      const questionMark = shiftSlash();
      const altQuestionMark = shiftSlash({ altKey: true });
      target.dispatchEvent(questionMark);
      target.dispatchEvent(altQuestionMark);
      expect(questionMark.defaultPrevented).toBe(false);
      expect(altQuestionMark.defaultPrevented).toBe(false);
      expect(actions.openKeymap).not.toHaveBeenCalled();
    });
  }

  it("suppresses shortcuts during IME composition without consuming the event", () => {
    const actions = runtime();
    const handler = createCommandKeydownHandler({
      registry: createCommandRegistry({ platform: "linux" }),
      runtime: actions,
      getContext: () => "app",
      document,
    });
    const event = shiftSlash({ isComposing: true });
    handler(event);
    expect(event.defaultPrevented).toBe(false);
    expect(actions.openKeymap).not.toHaveBeenCalled();
  });

  it("keymap.open is the only Shift+<punctuation> default across all command definitions", () => {
    const isPunctuation = (token: string) =>
      token.length === 1 && /[^A-Za-z0-9]/.test(token);
    const shiftedPunctuationDefaults = new Set<string>();
    for (const definition of commandDefinitions) {
      for (const platform of platforms) {
        const binding = definition.defaults[platform];
        if (binding === null) continue;
        const parts = binding.split("+");
        if (
          parts.length === 2 &&
          parts[0] === "Shift" &&
          isPunctuation(parts[1])
        )
          shiftedPunctuationDefaults.add(definition.id);
      }
    }
    expect(shiftedPunctuationDefaults).toEqual(new Set(["keymap.open"]));
  });

  it("does not regress non-shifted-punctuation dispatch (command palette, sidebar sequence)", () => {
    const actions = runtime();
    const handler = createCommandKeydownHandler({
      registry: createCommandRegistry({ platform: "linux" }),
      runtime: actions,
      getContext: () => "app",
      document,
    });
    handler(key("o", { ctrlKey: true }));
    expect(actions.openCommandPalette).toHaveBeenCalledOnce();
    handler(key("g"));
    handler(key("g"));
    expect(actions.navigateHome).toHaveBeenCalledOnce();
  });
});
