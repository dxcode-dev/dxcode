// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";

const ghostty = vi.hoisted(() => ({
  customKeyHandler: undefined as
    | undefined
    | ((event: KeyboardEvent) => boolean),
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
    observeResize() {}
    fit() {}
    dispose() {}
  },
}));

vi.mock("ghostty-web/ghostty-vt.wasm?url", () => ({
  default: "/ghostty-vt.wasm",
}));

import { mountBrowserTerminal } from "./ghostty-browser-emulator.js";

beforeEach(() => {
  vi.clearAllMocks();
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
});
