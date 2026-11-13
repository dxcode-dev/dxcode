// Mounts the real Pierre file editor for the browser tests of #1989, which
// prove where typing lands after Find, after a tap or click, and after Home.
import * as React from "react";
import { createRoot } from "react-dom/client";
import { expect } from "vitest";
import { userEvent } from "vitest/browser";
import { ThemeProvider } from "../../../shared/theme/theme-provider.js";
import { type FileEditorHandle, ThreadFileEditor } from "./file-editor.js";

export const original = Array.from({ length: 30 }, (_, index) =>
  index === 12 ? "    const needle = 1;" : `line ${index + 1} text`,
);

/** The original file with the given 1-based lines replaced. */
export const withLines = (changes: Record<number, string>) =>
  original.map((line, index) => changes[index + 1] ?? line).join("\n");

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

export const mountEditor = async () => {
  const container = document.body.appendChild(document.createElement("div"));
  const outside = document.body.appendChild(document.createElement("button"));
  outside.textContent = "Outside";
  const root = createRoot(container);
  const handle = React.createRef<FileEditorHandle>();
  let text = original.join("\n");
  await React.act(() =>
    root.render(
      <ThemeProvider preferences={{ appearance: "dark" }}>
        <ThreadFileEditor
          ref={handle}
          path="proof.ts"
          content={text}
          wrap={false}
          onChange={(next) => {
            text = next;
          }}
        />
      </ThemeProvider>,
    ),
  );
  // The editor loads its highlighter lazily; the first mount on a cold CI
  // runner takes longer than expect.poll's one-second default. A mount
  // that never appears still fails, and takes its nodes with it so later
  // tests start clean.
  try {
    await expect
      .poll(
        () =>
          container
            .querySelector("diffs-container")
            ?.shadowRoot?.querySelector('[contenteditable="true"]'),
        { timeout: 15_000 },
      )
      .toBeTruthy();
  } catch (error) {
    await React.act(() => root.unmount());
    container.remove();
    outside.remove();
    throw error;
  }
  const shadow = container.querySelector("diffs-container")?.shadowRoot;
  const editable = shadow?.querySelector<HTMLElement>(
    '[contenteditable="true"]',
  );
  if (shadow == null || editable == null) throw new Error("No editor");
  const focused = () => {
    let element = document.activeElement;
    while (element?.shadowRoot?.activeElement)
      element = element.shadowRoot.activeElement;
    return element;
  };
  return {
    shadow,
    editable,
    outside,
    focused,
    text: () => text,
    line: (number: number) => {
      const element = shadow.querySelector<HTMLElement>(
        `[data-line="${number}"]`,
      );
      if (element === null) throw new Error(`No line ${number}`);
      return element;
    },
    findInput: () =>
      shadow.querySelector<HTMLInputElement>("[data-search-panel] input"),
    findClose: () =>
      shadow.querySelector<HTMLElement>(
        "[data-search-panel] [data-search-close]",
      ),
    /** Opens Find from the toolbar's button and searches for `query`. */
    find: async (query: string) => {
      handle.current?.openFind();
      await settle();
      expect(focused()?.matches("[data-search-panel] input")).toBe(true);
      await userEvent.keyboard(query);
      await settle();
    },
    type: async (keys: string) => {
      await userEvent.keyboard(keys);
      await settle();
    },
    settle,
    unmount: async () => {
      await React.act(() => root.unmount());
      container.remove();
      outside.remove();
    },
  };
};
