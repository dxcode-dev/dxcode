// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ghostty = vi.hoisted(() => ({
  customKeyHandler: undefined as
    | undefined
    | ((event: KeyboardEvent) => boolean),
  fit: vi.fn(),
  load: vi.fn(),
  options: vi.fn(),
  textarea: undefined as HTMLTextAreaElement | undefined,
}));

vi.mock("ghostty-web", () => ({
  Ghostty: { load: ghostty.load },
  Terminal: class {
    textarea: HTMLTextAreaElement | undefined;
    constructor(options: unknown) {
      ghostty.options(options);
    }
    onData() {
      return { dispose: vi.fn() };
    }
    loadAddon() {}
    open() {
      this.textarea = document.createElement("textarea");
      ghostty.textarea = this.textarea;
    }
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
      ghostty.customKeyHandler = handler;
    }
    hasSelection() {
      return true;
    }
    getSelection() {
      return "selected terminal output";
    }
    dispose() {}
  },
  FitAddon: class {
    fit = ghostty.fit;
    dispose() {}
  },
}));

vi.mock("ghostty-web/ghostty-vt.wasm?url", () => ({
  default: "/ghostty-vt.wasm",
}));

import { mountBrowserTerminal } from "./ghostty-browser-emulator.js";

let resized: (() => void) | undefined;
const disconnect = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  resized = undefined;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resized = callback;
      }
      observe() {}
      disconnect = disconnect;
    },
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Ghostty browser emulator initialization", () => {
  it("loads Ghostty again after initialization rejects", async () => {
    const loaded = {};
    ghostty.load
      .mockRejectedValueOnce(new Error("WASM unavailable"))
      .mockResolvedValueOnce(loaded);
    const element = document.createElement("div");
    const theme = { background: "#ffffff", foreground: "#000000" };

    await expect(mountBrowserTerminal(element, vi.fn(), theme)).rejects.toThrow(
      "WASM unavailable",
    );
    await expect(
      mountBrowserTerminal(element, vi.fn(), theme),
    ).resolves.toMatchObject({ element });

    expect(ghostty.load).toHaveBeenCalledTimes(2);
    expect(ghostty.load).toHaveBeenNthCalledWith(2, "/ghostty-vt.wasm");
    expect(ghostty.options).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cursorBlink: false,
        fontSize: 13,
        scrollback: 10_000,
        theme,
      }),
    );
    expect(element.style.backgroundColor).toBe(theme.background);
    expect(element.style.caretColor).toBe("transparent");
    expect(ghostty.textarea?.style.caretColor).toBe("transparent");
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    expect(
      ghostty.customKeyHandler?.(
        new KeyboardEvent("keydown", {
          code: "KeyC",
          key: "c",
          metaKey: true,
        }),
      ),
    ).toBe(true);
    await vi.waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("selected terminal output"),
    );
  });

  it("fits the emulator only while its Terminal is visible", async () => {
    ghostty.load.mockResolvedValue({});
    vi.useFakeTimers();
    let visible = false;
    const emulator = await mountBrowserTerminal(
      document.createElement("div"),
      vi.fn(),
      {},
      () => visible,
    );
    // Neither the mount nor a resize fits a hidden Terminal: a collapsed pane
    // would shrink it, and its shell, to a few columns.
    resized?.();
    vi.advanceTimersByTime(100);
    expect(ghostty.fit).not.toHaveBeenCalled();

    visible = true;
    resized?.();
    vi.advanceTimersByTime(50);
    resized?.();
    vi.advanceTimersByTime(99);
    expect(ghostty.fit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(ghostty.fit).toHaveBeenCalledOnce();

    emulator.dispose();
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
