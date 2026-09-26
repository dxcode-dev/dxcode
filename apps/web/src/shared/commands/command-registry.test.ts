// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

import {
  type CommandRuntime,
  commandContextFromPath,
  commandDefinitions,
  createCommandRegistry,
  keyboardShortcutStorageKey,
  keymapCategories,
  keymapCategoryFor,
  reservedShortcutReason,
} from "./command-registry.js";

class MemoryStorage {
  readonly values = new Map<string, string>();

  constructor(value?: string) {
    if (value !== undefined) this.values.set(keyboardShortcutStorageKey, value);
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

class StorageEventsFixture {
  readonly listeners = new Set<(key: string | null) => void>();

  subscribe(listener: (key: string | null) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(key: string | null) {
    for (const listener of this.listeners) listener(key);
  }
}

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

describe("keyboard shortcut command registry", () => {
  it("has unique typed command ids and rejects duplicate definitions", () => {
    const ids = commandDefinitions.map((command) => command.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(() =>
      createCommandRegistry({ platform: "linux" }, [
        commandDefinitions[0],
        commandDefinitions[0],
      ]),
    ).toThrow("Duplicate command id: navigation.home");
  });

  it("derives one keymap grouping from command definitions with no second list", () => {
    expect(keymapCategories).toEqual([
      "Global",
      "Sidebar",
      "Thread",
      "Keyboard shortcuts",
    ]);
    expect(
      keymapCategoryFor({ id: "sidebar.open-menu", scope: "global" }),
    ).toBe("Sidebar");
    expect(
      keymapCategoryFor({ id: "thread.add-images", scope: "thread" }),
    ).toBe("Thread");
    expect(keymapCategoryFor({ id: "threads.search", scope: "global" })).toBe(
      "Global",
    );
    expect(
      keymapCategoryFor({
        id: "shortcuts.focus-search",
        scope: "keyboard-shortcuts",
      }),
    ).toBe("Keyboard shortcuts");
    expect(keymapCategoryFor({ id: "navigation.home", scope: "global" })).toBe(
      "Global",
    );
    for (const definition of commandDefinitions) {
      expect(keymapCategoryFor(definition)).toMatch(
        /^(Global|Sidebar|Thread|Keyboard shortcuts)$/,
      );
    }
  });

  it("resolves portable defaults and keycap display for every platform", () => {
    const mac = createCommandRegistry({ platform: "mac" });
    const windows = createCommandRegistry({ platform: "windows" });
    const linux = createCommandRegistry({ platform: "linux" });

    expect(mac.getBinding("command-palette.open")).toBe("Control+O");
    expect(
      mac.getCommands("app").find(({ id }) => id === "command-palette.open")
        ?.bindings,
    ).toEqual(["Control+O", "Mod+K"]);
    expect(mac.getDisplayedKeycaps("Mod+Shift+K")).toEqual(["⌘", "⇧", "K"]);
    expect(windows.getDisplayedKeycaps("Mod+Shift+K")).toEqual([
      "Ctrl",
      "Shift",
      "K",
    ]);
    expect(linux.getDisplayedKeycaps("Mod+Alt+K")).toEqual([
      "Ctrl",
      "Alt",
      "K",
    ]);
    expect(mac.getDisplayedKeycaps("Mod+B")).toEqual(["⌘", "B"]);
    expect(windows.getDisplayedKeycaps("Mod+B")).toEqual(["Ctrl", "B"]);
    expect(linux.getDisplayedKeycaps("Mod+B")).toEqual(["Ctrl", "B"]);
    expect(
      mac.getCommands("app").find(({ id }) => id === "keymap.open")
        ?.displayedKeycaps,
    ).toEqual(["?"]);
    expect(mac.setBinding("navigation.projects", "cmd+shift+p")).toMatchObject({
      ok: true,
      binding: "Mod+Shift+P",
    });
    expect(
      windows.setBinding("navigation.projects", "ctrl+shift+p"),
    ).toMatchObject({ ok: true, binding: "Mod+Shift+P" });
  });

  it("applies, clears, resets, and rehydrates device-local overrides", () => {
    const storage = new MemoryStorage();
    const registry = createCommandRegistry({ platform: "linux", storage });
    const listener = vi.fn();
    registry.subscribe(listener);

    expect(
      registry.setBinding("navigation.projects", "Control+Shift+P"),
    ).toMatchObject({ ok: true, binding: "Mod+Shift+P" });
    expect(registry.getBinding("navigation.projects")).toBe("Mod+Shift+P");
    expect(listener).toHaveBeenCalledOnce();
    expect(
      JSON.parse(storage.getItem(keyboardShortcutStorageKey) ?? ""),
    ).toEqual({
      version: 2,
      overrides: { "navigation.projects": "Mod+Shift+P" },
    });
    expect(
      createCommandRegistry({ platform: "linux", storage }).getBinding(
        "navigation.projects",
      ),
    ).toBe("Mod+Shift+P");

    registry.clearBinding("navigation.projects");
    expect(registry.getBinding("navigation.projects")).toBeNull();
    expect(
      createCommandRegistry({ platform: "linux", storage }).getBinding(
        "navigation.projects",
      ),
    ).toBeNull();

    registry.resetBinding("navigation.projects");
    expect(registry.getBinding("navigation.projects")).toBeNull();
    registry.setBinding("navigation.new-thread", "Mod+Shift+2");
    registry.resetAll();
    expect(registry.getBinding("navigation.new-thread")).toBe("Alt+Enter");
    expect(storage.getItem(keyboardShortcutStorageKey)).toBeNull();
  });

  it("clears and remaps a sequence without leaving its default keys active", () => {
    const storage = new MemoryStorage();
    const registry = createCommandRegistry({ platform: "linux", storage });

    registry.clearBinding("navigation.home");
    expect(
      registry.getCommands("app").find(({ id }) => id === "navigation.home"),
    ).toMatchObject({
      bindings: [],
      displayedBindings: [],
      sequence: undefined,
    });
    expect(
      createCommandRegistry({ platform: "linux", storage })
        .getCommands("app")
        .find(({ id }) => id === "navigation.home"),
    ).toMatchObject({ bindings: [], sequence: undefined });

    expect(registry.setBinding("navigation.home", "Mod+Shift+H")).toMatchObject(
      { ok: true },
    );
    expect(
      registry.getCommands("app").find(({ id }) => id === "navigation.home"),
    ).toMatchObject({
      bindings: ["Mod+Shift+H"],
      displayedBindings: [["Ctrl", "Shift", "H"]],
      sequence: undefined,
    });
  });

  it("detects global and context conflicts without blocking disjoint contexts", () => {
    const registry = createCommandRegistry({ platform: "linux" });

    expect(
      registry.setBinding("navigation.projects", "Control+O"),
    ).toMatchObject({
      ok: false,
      reason: "conflict",
      conflicts: [{ id: "command-palette.open" }],
    });
    expect(registry.setBinding("thread.focus-composer", "Mod+,")).toMatchObject(
      {
        ok: false,
        reason: "conflict",
        conflicts: [{ id: "navigation.settings" }],
      },
    );
    expect(
      registry.setBinding("shortcuts.restore-defaults", "Mod+Shift+F"),
    ).toMatchObject({
      ok: false,
      reason: "conflict",
      conflicts: [{ id: "shortcuts.focus-search" }],
    });
    expect(
      registry.setBinding("thread.focus-composer", "Mod+Shift+F"),
    ).toMatchObject({ ok: true });
  });

  it("rejects reserved browser and operating-system combinations", () => {
    expect(reservedShortcutReason("Control+L", "windows")).toBe(
      "focuses the browser address bar",
    );
    expect(reservedShortcutReason("Command+Space", "mac")).toBe(
      "opens Spotlight",
    );
    expect(reservedShortcutReason("Alt+Tab", "linux")).toBe(
      "switches applications",
    );

    expect(
      createCommandRegistry({ platform: "windows" }).setBinding(
        "navigation.projects",
        "Control+L",
      ),
    ).toMatchObject({ ok: false, reason: "reserved" });
    expect(
      createCommandRegistry({ platform: "mac" }).setBinding(
        "navigation.projects",
        "Command+Space",
      ),
    ).toMatchObject({ ok: false, reason: "reserved" });
  });

  it("rejects modifier-only bindings that cannot dispatch", () => {
    const registry = createCommandRegistry({ platform: "linux" });

    expect(registry.setBinding("navigation.projects", "Shift")).toMatchObject({
      ok: false,
      reason: "invalid",
      message: "A shortcut must include a non-modifier key.",
    });
    expect(
      registry.setBinding("navigation.projects", "Control+Shift"),
    ).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("discards malformed, unknown, reserved, and conflicting persisted values", () => {
    const storage = new MemoryStorage(
      JSON.stringify({
        "navigation.projects": "Mod+K",
        "navigation.new-thread": "NotAModifier+2",
        "navigation.settings": "Mod+L",
        "retired.command": "Mod+9",
        "thread.focus-composer": null,
      }),
    );
    const registry = createCommandRegistry({ platform: "linux", storage });

    expect(registry.getBinding("navigation.projects")).toBeNull();
    expect(registry.getBinding("navigation.new-thread")).toBe("Alt+Enter");
    expect(registry.getBinding("navigation.settings")).toBe("Mod+,");
    expect(registry.getBinding("thread.focus-composer")).toBeNull();
    expect(registry.getSnapshot().overrides).toEqual({
      "thread.focus-composer": null,
    });
    expect(
      JSON.parse(storage.getItem(keyboardShortcutStorageKey) ?? ""),
    ).toEqual({
      version: 2,
      overrides: { "thread.focus-composer": null },
    });
  });

  it("resets malformed and unsupported persisted versions", () => {
    for (const stored of ["not-json", JSON.stringify({ version: 0 })]) {
      const storage = new MemoryStorage(stored);
      const registry = createCommandRegistry({ platform: "linux", storage });
      expect(registry.getSnapshot().overrides).toEqual({});
      expect(
        JSON.parse(storage.getItem(keyboardShortcutStorageKey) ?? ""),
      ).toEqual({ version: 2, overrides: {} });
    }
  });

  it("uses stable empty server state and observes cross-tab changes", () => {
    const storage = new MemoryStorage(
      JSON.stringify({
        version: 1,
        overrides: { "navigation.projects": "Mod+Shift+P" },
      }),
    );
    const storageEvents = new StorageEventsFixture();
    const registry = createCommandRegistry({
      platform: "linux",
      storage,
      subscribeToStorage: (listener) => storageEvents.subscribe(listener),
    });
    const listener = vi.fn();
    const unsubscribe = registry.subscribe(listener);

    expect(registry.getBinding("navigation.projects")).toBe("Mod+Shift+P");
    expect(registry.getServerSnapshot()).toBe(registry.getServerSnapshot());
    expect(registry.getServerSnapshot().overrides).toEqual({});

    storage.setItem(
      keyboardShortcutStorageKey,
      JSON.stringify({
        version: 1,
        overrides: { "navigation.projects": null },
      }),
    );
    storageEvents.emit(keyboardShortcutStorageKey);
    expect(registry.getBinding("navigation.projects")).toBeNull();
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
    expect(storageEvents.listeners).toHaveLength(0);
  });

  it("derives availability and dispatches only executable current-context commands", () => {
    const registry = createCommandRegistry({ platform: "linux" });
    const actions = runtime();
    const appCommands = registry.getCommands("app");
    const threadCommands = registry.getCommands("thread");
    const shortcutCommands = registry.getCommands("keyboard-shortcuts");

    expect(
      appCommands.find((command) => command.id === "navigation.projects")
        ?.available,
    ).toBe(true);
    expect(
      appCommands.find((command) => command.id === "thread.focus-composer")
        ?.available,
    ).toBe(false);
    expect(
      threadCommands.find((command) => command.id === "thread.focus-composer")
        ?.available,
    ).toBe(true);
    expect(
      shortcutCommands.find(
        (command) => command.id === "shortcuts.focus-search",
      )?.available,
    ).toBe(true);
    expect(commandContextFromPath("/threads/thread-1")).toBe("thread");
    expect(commandContextFromPath("/settings/keyboard-shortcuts")).toBe(
      "keyboard-shortcuts",
    );
    expect(commandContextFromPath("/settings/appearance")).toBe("app");

    expect(registry.dispatch("navigation.projects", actions, "app")).toBe(true);
    expect(actions.navigateToProjects).toHaveBeenCalledOnce();
    expect(registry.dispatch("thread.focus-composer", actions, "app")).toBe(
      false,
    );
    expect(actions.focusThreadComposer).not.toHaveBeenCalled();
    expect(registry.dispatch("thread.focus-composer", actions, "thread")).toBe(
      true,
    );
    expect(actions.focusThreadComposer).toHaveBeenCalledOnce();
    expect(
      registry.dispatch(
        "shortcuts.restore-defaults",
        actions,
        "keyboard-shortcuts",
      ),
    ).toBe(true);
    expect(actions.restoreKeyboardShortcutDefaults).toHaveBeenCalledOnce();
  });

  it("shows sequence commands with their chord in every view", () => {
    const registry = createCommandRegistry({ platform: "linux" });
    const home = registry
      .getCommands("app")
      .find(({ id }) => id === "navigation.home");
    expect(home).toMatchObject({
      binding: null,
      bindings: [],
      sequence: ["g", "g"],
      displayedBindings: [["G"], ["G"]],
      customized: false,
    });
    expect(registry.getBinding("navigation.home")).toBeNull();
  });

  it("validates and persists sequence overrides without breaking single-chord edits", () => {
    const storage = new MemoryStorage();
    const registry = createCommandRegistry({ platform: "linux", storage });

    expect(
      registry.validateSequence("navigation.projects", ["g", "g"]),
    ).toMatchObject({
      ok: false,
      reason: "invalid",
    });
    expect(registry.validateSequence("navigation.home", ["g"])).toMatchObject({
      ok: false,
      reason: "invalid",
    });
    expect(
      registry.validateSequence("navigation.home", ["g", "h", "j"]),
    ).toMatchObject({
      ok: false,
      reason: "invalid",
      message:
        "A sequence shortcut for “Go to home screen” must contain exactly 2 keys.",
    });
    expect(
      registry.validateSequence("navigation.home", ["g", "Shift+H"]),
    ).toMatchObject({ ok: false, reason: "invalid" });
    // A sequence step may not collide with another command's live binding.
    expect(
      registry.validateSequence("navigation.home", ["j", "j"]),
    ).toMatchObject({
      ok: false,
      reason: "conflict",
      conflicts: [{ id: "sidebar.selection-down" }],
    });

    expect(registry.setSequence("navigation.home", ["g", "h"])).toMatchObject({
      ok: true,
      steps: ["G", "H"],
    });
    expect(
      registry.getCommands("app").find(({ id }) => id === "navigation.home"),
    ).toMatchObject({
      sequence: ["G", "H"],
      displayedBindings: [["G"], ["H"]],
      customized: true,
    });
    expect(
      JSON.parse(storage.getItem(keyboardShortcutStorageKey) ?? ""),
    ).toEqual({
      version: 2,
      overrides: { "navigation.home": { sequence: ["G", "H"] } },
    });
    expect(
      createCommandRegistry({ platform: "linux", storage })
        .getCommands("app")
        .find(({ id }) => id === "navigation.home"),
    ).toMatchObject({ sequence: ["G", "H"], customized: true });

    // Recording the default chord again removes the override entirely.
    expect(registry.setSequence("navigation.home", ["g", "g"])).toMatchObject({
      ok: true,
    });
    expect(
      createCommandRegistry({ platform: "linux", storage }).getSnapshot()
        .overrides,
    ).toEqual({});

    // A single chord on a sequence command still replaces the sequence.
    expect(registry.setBinding("navigation.home", "Mod+Shift+H")).toMatchObject(
      {
        ok: true,
      },
    );
    expect(
      registry.getCommands("app").find(({ id }) => id === "navigation.home"),
    ).toMatchObject({ binding: "Mod+Shift+H", sequence: undefined });
  });

  it("drops persisted sequence overrides that collide with other bindings", () => {
    const storage = new MemoryStorage(
      JSON.stringify({
        version: 2,
        overrides: {
          "navigation.home": { sequence: ["j", "j"] },
          "sidebar.open-menu": { sequence: ["m", "m"] },
          "navigation.projects": "Mod+Shift+P",
        },
      }),
    );
    const registry = createCommandRegistry({ platform: "linux", storage });
    expect(registry.getSnapshot().overrides).toEqual({
      "navigation.projects": "Mod+Shift+P",
    });
  });

  it("drops longer persisted sequences and records exactly the declared length", () => {
    const storage = new MemoryStorage(
      JSON.stringify({
        version: 2,
        overrides: {
          "navigation.home": { sequence: ["x", "y", "z"] },
        },
      }),
    );
    const registry = createCommandRegistry({ platform: "linux", storage });
    expect(registry.getSnapshot().overrides).toEqual({});
    expect(
      JSON.parse(storage.getItem(keyboardShortcutStorageKey) ?? ""),
    ).toEqual({ version: 2, overrides: {} });

    const recorded: unknown[] = [];
    registry.startRecording("navigation.home", {
      onRecorded: (proposal) => recorded.push(proposal),
    });
    for (const key of ["x", "y", "z"]) {
      registry.recordKeyboardEvent(
        new KeyboardEvent("keydown", { key, cancelable: true }),
      );
    }
    expect(recorded).toEqual([{ kind: "sequence", steps: ["X", "Y"] }]);
    expect(registry.getSnapshot().recording).toBeNull();
  });

  it("migrates the v1 envelope and legacy raw map to v2 at load", () => {
    for (const stored of [
      JSON.stringify({
        version: 1,
        overrides: { "navigation.projects": "Mod+Shift+P" },
      }),
      JSON.stringify({ "navigation.projects": "Mod+Shift+P" }),
    ]) {
      const storage = new MemoryStorage(stored);
      const registry = createCommandRegistry({ platform: "linux", storage });
      expect(registry.getBinding("navigation.projects")).toBe("Mod+Shift+P");
      expect(
        JSON.parse(storage.getItem(keyboardShortcutStorageKey) ?? ""),
      ).toEqual({
        version: 2,
        overrides: { "navigation.projects": "Mod+Shift+P" },
      });
    }
  });

  it("captures plain keys into a sequence session and completes at length", () => {
    const registry = createCommandRegistry({ platform: "linux" });
    const recorded: unknown[] = [];
    registry.startRecording("navigation.home", {
      onRecorded: (proposal) => recorded.push(proposal),
    });
    expect(registry.getSnapshot().recording).toMatchObject({
      commandId: "navigation.home",
      steps: [],
    });
    registry.recordKeyboardEvent(
      new KeyboardEvent("keydown", { key: "g", cancelable: true }),
    );
    expect(registry.getSnapshot().recording).toMatchObject({
      commandId: "navigation.home",
      steps: ["G"],
    });
    registry.recordKeyboardEvent(
      new KeyboardEvent("keydown", { key: "h", cancelable: true }),
    );
    expect(registry.getSnapshot().recording).toBeNull();
    expect(recorded).toEqual([{ kind: "sequence", steps: ["G", "H"] }]);

    // Modifier-only key presses never record a step.
    registry.startRecording("navigation.home");
    registry.recordKeyboardEvent(
      new KeyboardEvent("keydown", { key: "Shift", cancelable: true }),
    );
    expect(registry.getSnapshot().recording).toMatchObject({ steps: [] });
    registry.cancelRecording();
    expect(registry.getSnapshot().recording).toBeNull();

    // Repeated Backspace pops recorded steps one at a time.
    const popped: unknown[] = [];
    registry.startRecording("navigation.home", {
      onRecorded: (proposal) => popped.push(proposal),
    });
    registry.recordKeyboardEvent(
      new KeyboardEvent("keydown", { key: "g", cancelable: true }),
    );
    registry.recordKeyboardEvent(
      new KeyboardEvent("keydown", { key: "h", cancelable: true }),
    );
    // Two plain keys complete the default-length sequence immediately.
    expect(registry.getSnapshot().recording).toBeNull();
    expect(popped).toEqual([{ kind: "sequence", steps: ["G", "H"] }]);

    registry.startRecording("navigation.home", {
      onRecorded: (proposal) => popped.push(proposal),
    });
    registry.recordKeyboardEvent(
      new KeyboardEvent("keydown", { key: "g", cancelable: true }),
    );
    registry.recordKeyboardEvent(
      new KeyboardEvent("keydown", { key: "Backspace", cancelable: true }),
    );
    expect(registry.getSnapshot().recording).toMatchObject({ steps: [] });
    // Backspace on an empty session proposes clearing the whole shortcut.
    registry.recordKeyboardEvent(
      new KeyboardEvent("keydown", { key: "Backspace", cancelable: true }),
    );
    expect(registry.getSnapshot().recording).toBeNull();
    expect(popped).toEqual([
      { kind: "sequence", steps: ["G", "H"] },
      { kind: "clear" },
    ]);
  });

  it("keeps single-chord recording semantics for non-sequence commands", () => {
    const registry = createCommandRegistry({ platform: "linux" });
    const recorded: unknown[] = [];
    registry.startRecording("navigation.projects", {
      onRecorded: (proposal) => recorded.push(proposal),
    });
    registry.recordKeyboardEvent(
      new KeyboardEvent("keydown", {
        key: "p",
        ctrlKey: true,
        shiftKey: true,
        cancelable: true,
      }),
    );
    expect(registry.getSnapshot().recording).toBeNull();
    expect(recorded).toEqual([{ kind: "hotkey", hotkey: "Mod+Shift+P" }]);
  });
});
