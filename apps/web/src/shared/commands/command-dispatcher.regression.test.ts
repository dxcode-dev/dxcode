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
    openThreadView: vi.fn(),
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
});
