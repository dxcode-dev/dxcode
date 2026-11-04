/**
 * Adding and moving between blocks in the artifact editor, with real key
 * presses and clicks (#1651, the owner's report).
 *
 * Ways it can fail, each covered below:
 *  1. Inserting a table leaves the caret outside it, or in the wrong cell.
 *  2. An arrow key puts the caret between cells (in the row), so the next
 *     keystroke makes a new cell and the table goes ragged.
 *  3. Tab or Shift+Tab skips or leaves the table.
 *  4. The caret cannot leave a table that is the first or the last block.
 *  5. A click or tap below the last block does nothing, so nothing can be
 *     added after a table, a code block, or a view.
 *  6. Markdown typed into the document (`#`, `- [ ]`, `| A | B |`, a fence
 *     with its language) does not become the block it names.
 *  7. The block handle cannot be reached from the keyboard.
 */
import type { ThreadArtifact } from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import { QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { AuthContext } from "../../../shared/auth/auth-context.js";
import { createQueryClient } from "../../../shared/query/query-client.js";
import { ArtifactEditor } from "./artifact-editor.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const threadId = "thr_00000000-0000-4000-8000-0000000000b1" as ThreadId;
const userId = "usr_blocks" as UserId;

const artifact = (): ThreadArtifact => ({
  id: `art_${"b".repeat(32)}`,
  threadId,
  folder: "",
  title: "Blocks",
  revision: 1,
  sizeBytes: 0,
  createdBy: { kind: "agent" },
  updatedBy: { kind: "agent" },
  openCommentCount: 0,
  createdAt: 0,
  updatedAt: 0,
});

let root: Root | undefined;
afterEach(async () => {
  await React.act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

/** The editor on `markdown`; requests never answer, so nothing saves. */
const mount = async (markdown: string) => {
  vi.stubGlobal("fetch", () => new Promise<Response>(() => {}));
  const container = document.body.appendChild(document.createElement("div"));
  container.style.height = "800px";
  container.style.display = "flex";
  root = createRoot(container);
  await React.act(() =>
    root?.render(
      <QueryClientProvider client={createQueryClient()}>
        <AuthContext
          value={{
            identity: { id: userId, name: "Test", email: "t@dx.test" },
            logout: () => undefined,
          }}
        >
          <ArtifactEditor
            threadId={threadId}
            initial={{ artifact: artifact(), markdown }}
            readOnly={false}
            switcher={null}
          />
        </AuthContext>
      </QueryClientProvider>,
    ),
  );
  const prose = container.querySelector<HTMLElement>(".artifact-prose");
  if (prose === null) throw new Error("Expected the editor.");
  return { container, prose };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

const press = async (...keys: string[]) => {
  for (const key of keys) {
    await userEvent.keyboard(key);
    await settle();
  }
};

/** Where the caret is: a table cell's row and column, or the block it is in. */
const caret = () => {
  const node = getSelection()?.anchorNode ?? null;
  const element = node instanceof Element ? node : node?.parentElement;
  const cell = element?.closest("td, th");
  if (cell instanceof HTMLTableCellElement) {
    const row = cell.parentElement as HTMLTableRowElement;
    return { row: row.rowIndex, column: cell.cellIndex };
  }
  return (
    element?.closest(".artifact-prose > *")?.tagName.toLowerCase() ?? "none"
  );
};

/** Each row's number of cells. */
const shape = (prose: HTMLElement, index = 0) =>
  [...(prose.querySelectorAll("table")[index]?.rows ?? [])].map(
    (row) => row.cells.length,
  );

/** Puts the caret at the end of the block holding `text`. */
const caretAtEndOf = async (prose: HTMLElement, text: string) => {
  const block = [...prose.querySelectorAll("p, h1, h2, li, td, th, pre")].find(
    (element) => element.textContent?.includes(text),
  );
  if (block === undefined) throw new Error(`No block with ${text}`);
  await userEvent.click(block);
  await press("{End}");
};

const toolbar = (container: HTMLElement, name: string) => {
  const button = [
    ...container.querySelectorAll<HTMLButtonElement>(
      ".artifact-toolbar button",
    ),
  ].find((candidate) => candidate.textContent?.trim() === name);
  if (button === undefined) throw new Error(`No ${name} button`);
  return button;
};

describe("tables", () => {
  it("inserts a table with the caret in its first cell, at the start, middle, and end", async () => {
    for (const [markdown, at] of [
      ["", undefined],
      ["One.\n\nTwo.\n", "One."],
      ["One.\n\nTwo.\n", "Two."],
    ] as const) {
      const { container, prose } = await mount(markdown);
      if (at === undefined) await userEvent.click(prose);
      else await caretAtEndOf(prose, at);
      await userEvent.click(toolbar(container, "Table"));
      await settle();
      expect(caret(), `${JSON.stringify(markdown)} at ${at}`).toEqual({
        row: 0,
        column: 0,
      });
      await React.act(() => root?.unmount());
      root = undefined;
      document.body.replaceChildren();
    }
  });

  it("moves with arrows, Tab, and Shift+Tab between cells and rows, and never makes a cell", async () => {
    const { container, prose } = await mount("");
    await userEvent.click(prose);
    await userEvent.click(toolbar(container, "Table"));
    await settle();
    await userEvent.keyboard("A");
    await press("{ArrowRight}");
    expect(caret()).toEqual({ row: 0, column: 1 });
    await press("{ArrowDown}");
    expect(caret()).toEqual({ row: 1, column: 1 });
    await press("{ArrowLeft}");
    expect(caret()).toEqual({ row: 1, column: 0 });
    await press("{ArrowUp}");
    expect(caret()).toEqual({ row: 0, column: 0 });
    await press("{ArrowDown}", "{ArrowDown}");
    expect(caret()).toEqual({ row: 2, column: 0 });
    await press("{Tab}");
    expect(caret()).toEqual({ row: 2, column: 1 });
    await press("{Shift>}{Tab}{/Shift}");
    expect(caret()).toEqual({ row: 2, column: 0 });
    await userEvent.keyboard("B");
    await press("{ArrowUp}", "{ArrowRight}", "{ArrowDown}");
    expect(caret()).toEqual({ row: 2, column: 1 });
    await userEvent.keyboard("C");
    expect(shape(prose)).toEqual([3, 3, 3]);
    expect(prose.querySelector("table")?.textContent).toBe("ABC");
  });

  it("leaves a table that is the first and the last block, below and above", async () => {
    const { container, prose } = await mount("");
    await userEvent.click(prose);
    await userEvent.click(toolbar(container, "Table"));
    await settle();
    await press("{ArrowDown}", "{ArrowDown}", "{ArrowDown}");
    await userEvent.keyboard("below");
    await settle();
    expect(prose.lastElementChild?.tagName).toBe("P");
    expect(prose.lastElementChild?.textContent).toBe("below");
    await press("{ArrowUp}", "{ArrowUp}", "{ArrowUp}", "{ArrowUp}");
    await userEvent.keyboard("above");
    await settle();
    expect(prose.firstElementChild?.tagName).toBe("P");
    expect(prose.firstElementChild?.textContent).toBe("above");
    expect(shape(prose)).toEqual([3, 3, 3]);
  });
});

describe("code blocks", () => {
  it("leaves a code block with the arrow keys, above and below", async () => {
    const { prose } = await mount("```ts\nconst x = 1;\n```\n");
    await caretAtEndOf(prose, "const x");
    await press("{ArrowDown}");
    await userEvent.keyboard("below");
    await settle();
    expect(prose.querySelector("pre")?.textContent).toBe("const x = 1;");
    expect(prose.lastElementChild?.textContent).toBe("below");
    await press("{ArrowUp}", "{ArrowUp}");
    await userEvent.keyboard("above");
    await settle();
    expect(prose.firstElementChild?.tagName).toBe("P");
    expect(prose.firstElementChild?.textContent).toBe("above");
  });
});

describe("the space below the document", () => {
  for (const [name, markdown] of [
    ["a table", "| A | B |\n| --- | --- |\n| 1 | 2 |\n"],
    ["a code block", "```ts\nconst x = 1;\n```\n"],
    ["a paragraph", "Last line.\n"],
  ] as const) {
    it(`adds a paragraph below ${name} on a click there`, async () => {
      const { container, prose } = await mount(markdown);
      const scroll = container.querySelector<HTMLElement>(".artifact-scroll");
      if (scroll === null) throw new Error("Expected the scroll area.");
      const below = prose.getBoundingClientRect().bottom + 30;
      await userEvent.click(scroll, {
        position: {
          x: 200,
          y: below - scroll.getBoundingClientRect().top,
        },
      });
      await settle();
      await userEvent.keyboard("next");
      await settle();
      expect(prose.lastElementChild?.tagName).toBe("P");
      expect(prose.lastElementChild?.textContent).toBe("next");
    });
  }
});

describe("blocks from the keyboard", () => {
  it("turns typed Markdown into the block it names", async () => {
    const { prose } = await mount("");
    await userEvent.click(prose);
    await userEvent.keyboard("# Title{Enter}");
    await userEvent.keyboard("- [[ ] Task{Enter}{Enter}");
    await userEvent.keyboard("| Name | State |{Enter}");
    await settle();
    expect(prose.querySelector("h1")?.textContent).toBe("Title");
    expect(prose.querySelector("li.artifact-task")?.textContent).toContain(
      "Task",
    );
    expect(shape(prose)).toEqual([2, 2]);
    expect(prose.querySelector("th")?.textContent).toBe("Name");
    expect(caret()).toEqual({ row: 1, column: 0 });
    await press("{ArrowDown}");
    await userEvent.keyboard("```ts{Enter}const x = 1;");
    await settle();
    const code = prose.querySelector("pre[data-language='ts']");
    expect(code?.textContent).toContain("const x = 1;");
  });

  it("reaches the block handle from the keyboard", async () => {
    const { container, prose } = await mount("One.\n");
    await caretAtEndOf(prose, "One.");
    await press("{Tab}");
    expect(document.activeElement).toBe(
      container.querySelector('[aria-label="Insert Below"]'),
    );
  });
});
