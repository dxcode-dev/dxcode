/**
 * The block handle beside the block under the pointer: its menus stay open
 * while the pointer travels to them, and its grip drags the block to a new
 * place (#1651, the owner's report).
 *
 * Ways it can fail, each covered below:
 *  1. Moving the pointer to an open menu passes over other blocks, which
 *     moves the handle (and the block the menu acts on), or leaves the
 *     editor, which unmounts the handle and closes the menu.
 *  2. A press on the grip opens the menu at once, so it cannot drag; or a
 *     click (no movement) no longer opens Block Options.
 *  3. A dragged block lands in the wrong place, shows no drop line, splits,
 *     or takes several undos to put back.
 *  4. A table, a list with nested items, or an image does not move whole.
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
const userId = "usr_handle" as UserId;

const artifact = (): ThreadArtifact => ({
  id: `art_${"f".repeat(32)}`,
  threadId,
  folder: "",
  title: "Handle",
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
  container.style.height = "700px";
  container.style.width = "800px";
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

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

/** The top-level blocks, each as its text. */
const blocks = (prose: HTMLElement) =>
  [...prose.children]
    .map((block) =>
      block.querySelector("img") === null
        ? (block.textContent ?? "").trim()
        : "[image]",
    )
    .filter((text) => text !== "");

const blockWith = (prose: HTMLElement, text: string) => {
  const block = [...prose.children].find((child) =>
    (child.textContent ?? "").includes(text),
  );
  if (!(block instanceof HTMLElement)) throw new Error(`No block ${text}`);
  return block;
};

const grip = () => {
  const button = document.querySelector<HTMLElement>(
    "button[aria-label='Block Options']",
  );
  if (button === null) throw new Error("No grip.");
  return button;
};

const menuItem = (name: string) =>
  [...document.querySelectorAll<HTMLElement>("[role=menuitem]")].find(
    (item) => item.textContent?.trim() === name,
  );

const THREE = "One\n\nTwo\n\nThree\n";

describe("the handle's menus", () => {
  it("keep Block Options open and acting on its block while the pointer crosses other blocks to the menu", async () => {
    const { prose } = await mount(THREE);
    // The caret is in another block, which the handle falls back to.
    await userEvent.click(blockWith(prose, "Three"));
    await userEvent.hover(blockWith(prose, "One"));
    await settle();
    await userEvent.click(grip());
    await settle();
    expect(menuItem("Move Down")).toBeDefined();
    // On the way to the menu: over another block, then out of the editor.
    // The open menu's backdrop covers the page, so the pointer reaches the
    // spot over Three as a mouse would, whatever is on top.
    await userEvent.hover(blockWith(prose, "Three"), { force: true });
    await settle();
    const moveDown = menuItem("Move Down");
    if (moveDown === undefined) throw new Error("The menu closed.");
    await userEvent.hover(moveDown);
    await settle();
    expect(menuItem("Move Down")).toBeDefined();
    await userEvent.click(moveDown);
    await settle();
    expect(blocks(prose)).toEqual(["Two", "One", "Three"]);
  });

  it("keeps Insert Below open while the pointer crosses other blocks", async () => {
    const { prose } = await mount(THREE);
    await userEvent.click(blockWith(prose, "Three"));
    await userEvent.hover(blockWith(prose, "One"));
    await settle();
    const insert = document.querySelector<HTMLElement>(
      "button[aria-label='Insert Below']",
    );
    if (insert === null) throw new Error("No Insert Below.");
    await userEvent.click(insert);
    await settle();
    // The open menu's backdrop covers the page, so the pointer reaches the
    // spot over Three as a mouse would, whatever is on top.
    await userEvent.hover(blockWith(prose, "Three"), { force: true });
    await settle();
    const quote = menuItem("Quote");
    if (quote === undefined) throw new Error("The menu closed.");
    await userEvent.hover(quote);
    await userEvent.click(quote);
    await settle();
    expect(
      prose.querySelector("blockquote")?.previousElementSibling?.textContent,
    ).toBe("One");
  });
});

/** Presses the grip of `from`'s block and releases it at `y` over `over`. */
const drag = async (
  prose: HTMLElement,
  from: string,
  over: HTMLElement,
  y: number,
) => {
  await userEvent.hover(blockWith(prose, from));
  await settle();
  await userEvent.dragAndDrop(
    page.elementLocator(grip()),
    page.elementLocator(over),
    {
      targetPosition: { x: 20, y },
    },
  );
  await settle();
};

describe("dragging a block by its grip", () => {
  it("moves the block, shows where it will land, and undoes in one step; a click still opens the menu", async () => {
    const { prose } = await mount(THREE);
    const three = blockWith(prose, "Three");
    await drag(prose, "One", three, three.getBoundingClientRect().height - 2);
    expect(blocks(prose)).toEqual(["Two", "Three", "One"]);
    expect(document.querySelector("[role=menu]")).toBeNull();
    prose.focus();
    await userEvent.keyboard("{Control>}z{/Control}");
    await settle();
    expect(blocks(prose)).toEqual(["One", "Two", "Three"]);
    // A click without moving opens Block Options.
    await userEvent.hover(blockWith(prose, "Two"));
    await settle();
    await userEvent.click(grip());
    await settle();
    expect(menuItem("Move Up")).toBeDefined();
  });

  it("shows a drop line while dragging", async () => {
    const { prose } = await mount(THREE);
    await userEvent.hover(blockWith(prose, "One"));
    await settle();
    const box = grip().getBoundingClientRect();
    const target = blockWith(prose, "Three").getBoundingClientRect();
    grip().dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        pointerType: "mouse",
        pointerId: 1,
        button: 0,
        buttons: 1,
        clientX: box.left + 4,
        clientY: box.top + 4,
      }),
    );
    await settle();
    grip().dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        pointerType: "mouse",
        pointerId: 1,
        buttons: 1,
        clientX: target.left + 20,
        clientY: target.bottom - 2,
      }),
    );
    await settle();
    const line = document.querySelector<HTMLElement>(".artifact-drop-line");
    expect(line).not.toBeNull();
    expect(
      Math.abs((line?.getBoundingClientRect().top ?? 0) - target.bottom),
    ).toBeLessThan(12);
    grip().dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        pointerType: "mouse",
        pointerId: 1,
        clientX: target.left + 20,
        clientY: target.bottom - 2,
      }),
    );
    await settle();
    expect(document.querySelector(".artifact-drop-line")).toBeNull();
    expect(blocks(prose)).toEqual(["Two", "Three", "One"]);
  });

  it("moves a table, a list with nested items, and an image whole", async () => {
    const { prose } = await mount(
      [
        "Top",
        "",
        "| A | B |",
        "| --- | --- |",
        "| 1 | 2 |",
        "",
        "- Outer",
        "  - Inner",
        "",
        "![chart](/v1/threads/thr_1/storage/tsf_1/chart.png)",
        "",
        "End",
        "",
      ].join("\n"),
    );
    const end = blockWith(prose, "End");
    // The table to the end.
    await drag(prose, "AB", end, end.getBoundingClientRect().height - 2);
    expect(blocks(prose)).toEqual([
      "Top",
      "OuterInner",
      "[image]",
      "End",
      "AB12",
    ]);
    // The list (with its nested item) to the top.
    const top = blockWith(prose, "Top");
    await drag(prose, "Outer", top, 2);
    expect(blocks(prose)).toEqual([
      "OuterInner",
      "Top",
      "[image]",
      "End",
      "AB12",
    ]);
    expect(prose.querySelectorAll("ul ul li").length).toBe(1);
    // The image above Top.
    const image = prose.querySelector("img")?.closest(".artifact-prose > *");
    if (!(image instanceof HTMLElement)) throw new Error("No image block.");
    await userEvent.hover(image);
    await settle();
    await userEvent.dragAndDrop(
      page.elementLocator(grip()),
      page.elementLocator(blockWith(prose, "Top")),
      { targetPosition: { x: 20, y: 2 } },
    );
    await settle();
    expect(blocks(prose)).toEqual([
      "OuterInner",
      "[image]",
      "Top",
      "End",
      "AB12",
    ]);
  });
});
