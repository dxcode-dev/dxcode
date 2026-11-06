/**
 * Small editor gaps against the reference editor (#1810): the empty-line
 * placeholder, Turn Into's kinds, an Image button, and Find with Ctrl+F.
 *
 * Ways it can fail, each covered below:
 *  1. An empty paragraph past the first shows no hint, a hint shows where
 *     there is text or in a reader's view, or it still reads "Start
 *     writing…".
 *  2. Turn Into lacks Divider, Table, or Image, or turning a paragraph into
 *     one of them loses its text.
 *  3. The toolbar has no Image button, or it does not open the file picker.
 *  4. Ctrl+F opens the browser's find instead of the artifact's, finds
 *     nothing case-insensitively, miscounts, does not move between matches
 *     (Enter, Shift+Enter, the arrows) or wrap, highlights nothing, or
 *     leaves highlights after Escape.
 */
import type { ThreadArtifact } from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import { QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { AuthContext } from "../../../shared/auth/auth-context.js";
import { createQueryClient } from "../../../shared/query/query-client.js";
import { ArtifactEditor } from "./artifact-editor.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const threadId = "thr_00000000-0000-4000-8000-0000000000f1" as ThreadId;
const userId = "usr_find" as UserId;
const artifact: ThreadArtifact = {
  id: `art_${"f".repeat(32)}`,
  threadId,
  folder: "",
  title: "Gaps",
  revision: 1,
  sizeBytes: 0,
  createdBy: { kind: "agent" },
  updatedBy: { kind: "agent" },
  openCommentCount: 0,
  createdAt: 0,
  updatedAt: 0,
};

let root: Root | undefined;
afterEach(async () => {
  await React.act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const mount = async (markdown: string, readOnly = false) => {
  vi.stubGlobal("fetch", () => new Promise<Response>(() => {}));
  const container = document.body.appendChild(document.createElement("div"));
  container.style.cssText = "height:760px;width:1000px;display:flex";
  root = createRoot(container);
  await React.act(() =>
    root?.render(
      <QueryClientProvider client={createQueryClient()}>
        <AuthContext
          value={{
            identity: { id: userId, name: "Fi", email: "f@dx.test" },
            logout: () => undefined,
          }}
        >
          <ArtifactEditor
            threadId={threadId}
            initial={{ artifact, markdown }}
            readOnly={readOnly}
            switcher={null}
          />
        </AuthContext>
      </QueryClientProvider>,
    ),
  );
  await settle(150);
  const prose = container.querySelector<HTMLElement>(".artifact-prose");
  if (prose === null) throw new Error("No editor.");
  return prose;
};

const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));
const HINT = "Type / for blocks, @ to mention";
const hints = (prose: HTMLElement) =>
  [...prose.querySelectorAll<HTMLElement>("[data-placeholder]")].map(
    (node) => node.dataset.placeholder,
  );

describe("the empty-line hint", () => {
  it("shows on every empty paragraph, and nowhere with text", async () => {
    const prose = await mount("First.\n");
    expect(hints(prose)).toEqual([]);
    await userEvent.click(prose.querySelector("p") as HTMLElement);
    await userEvent.keyboard("{End}{Enter}");
    await settle();
    expect(hints(prose)).toEqual([HINT]);
    await userEvent.keyboard("{Enter}");
    await settle();
    expect(hints(prose)).toEqual([HINT, HINT]);
    await userEvent.keyboard("x");
    await settle();
    expect(hints(prose)).toEqual([HINT]);
  });

  it("shows on an empty document, but not to a reader", async () => {
    expect(hints(await mount(""))).toEqual([HINT]);
    await React.act(() => root?.unmount());
    document.body.replaceChildren();
    expect(hints(await mount("", true))).toEqual([]);
  });
});

describe("Turn Into", () => {
  const turn = async (prose: HTMLElement, kind: string) => {
    const block = prose.querySelector<HTMLElement>("p");
    if (block === null) throw new Error("No paragraph.");
    await userEvent.click(block);
    await settle();
    await userEvent.click(page.getByRole("button", { name: "Block Options" }));
    await settle(120);
    await userEvent.click(page.getByRole("menuitem", { name: "Turn Into" }));
    await settle(120);
    const items = [
      ...document.querySelectorAll<HTMLElement>(
        '[aria-label="Turn Into"] [role="menuitem"]',
      ),
    ].map((item) => item.textContent?.trim());
    await userEvent.click(
      page.getByRole("menuitem", { name: kind, exact: true }),
    );
    await settle(150);
    return items;
  };

  it("offers Divider, Table, and Image beside the text kinds", async () => {
    const prose = await mount("Keep this.\n");
    const items = await turn(prose, "Divider");
    for (const kind of ["Text", "Heading 1", "Checklist", "Quote", "Code"])
      expect(items).toContain(kind);
    for (const kind of ["Divider", "Table", "Image"])
      expect(items).toContain(kind);
    // A divider, with the text kept under it.
    expect(prose.querySelector("hr")).not.toBeNull();
    expect(prose.querySelector("hr + p")?.textContent).toBe("Keep this.");
  });

  it("turns a paragraph into a table that holds its text", async () => {
    const prose = await mount("Keep this.\n");
    await turn(prose, "Table");
    expect(prose.querySelector("table")?.textContent).toContain("Keep this.");
  });

  it("opens the image picker for Image, keeping the text", async () => {
    const prose = await mount("Keep this.\n");
    const picked = vi.spyOn(HTMLInputElement.prototype, "click");
    await turn(prose, "Image");
    expect(
      picked.mock.contexts.some(
        (input) => (input as HTMLInputElement).type === "file",
      ),
    ).toBe(true);
    expect(prose.textContent).toContain("Keep this.");
  });
});

describe("the toolbar's Image button", () => {
  it("opens the file picker", async () => {
    await mount("Text.\n");
    const picked = vi.spyOn(HTMLInputElement.prototype, "click");
    await userEvent.click(
      page.getByRole("button", { name: "Insert Image", exact: true }),
    );
    expect(
      picked.mock.contexts.some(
        (input) => (input as HTMLInputElement).type === "file",
      ),
    ).toBe(true);
  });
});

describe("Find", () => {
  const SOURCE =
    "Agent one.\n\nThe AGENT reads; the agent writes.\n\n| Who | Note |\n| --- | --- |\n| agent | done |\n";
  const field = () =>
    document.querySelector<HTMLInputElement>(
      'input[aria-label="Find in artifact"]',
    );
  const count = () =>
    document.querySelector(".artifact-find-count")?.textContent;
  const marks = (prose: HTMLElement) =>
    [...prose.querySelectorAll<HTMLElement>(".artifact-find-match")].map(
      (mark) => mark.classList.contains("artifact-find-current"),
    );

  it("opens on Ctrl+F, counts every match in any case, moves, wraps, and closes", async () => {
    const prose = await mount(SOURCE);
    await userEvent.click(prose.querySelector("p") as HTMLElement);
    const native = new KeyboardEvent("keydown", {
      key: "f",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    prose.dispatchEvent(native);
    await settle(150);
    // The artifact's Find, not the browser's.
    expect(native.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(field());
    await userEvent.keyboard("agent");
    await settle(150);
    expect(count()).toBe("1 of 4");
    expect(marks(prose)).toEqual([true, false, false, false]);
    await userEvent.keyboard("{Enter}");
    await settle();
    expect(count()).toBe("2 of 4");
    expect(marks(prose)).toEqual([false, true, false, false]);
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}{Shift>}{Enter}{/Shift}");
    await settle();
    // Back past the first, to the last.
    expect(count()).toBe("4 of 4");
    await userEvent.click(page.getByRole("button", { name: "Next Match" }));
    await settle();
    expect(count()).toBe("1 of 4");
    await userEvent.click(page.getByRole("button", { name: "Previous Match" }));
    await settle();
    expect(count()).toBe("4 of 4");
    await userEvent.click(field() as HTMLInputElement);
    await userEvent.keyboard("{Control>}a{/Control}zzz");
    await settle();
    expect(count()).toBe("No results");
    expect(marks(prose)).toEqual([]);
    await userEvent.keyboard("{Control>}a{/Control}agent{Escape}");
    await settle(150);
    expect(field()).toBeNull();
    expect(marks(prose)).toEqual([]);
  });

  it("opens from the toolbar's Find button, and for a reader too", async () => {
    const prose = await mount(SOURCE, true);
    await userEvent.click(
      page.getByRole("button", { name: "Find in Artifact", exact: true }),
    );
    await settle(150);
    expect(document.activeElement).toBe(field());
    await userEvent.keyboard("reads");
    await settle(150);
    expect(count()).toBe("1 of 1");
    expect(marks(prose)).toEqual([true]);
  });
});
