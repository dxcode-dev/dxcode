import type { ThreadPaneFileTarget } from "@dx/api";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { paneLayoutWith } from "../../../testing/pane-layouts.js";
import { PaneTreeHarness } from "../../../testing/pane-tree-harness.js";
import { reducePaneLayout } from "./pane-layout.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const roots: Root[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await React.act(() => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

const mount = async (element: React.ReactElement) => {
  const container = document.body.appendChild(document.createElement("div"));
  container.style.cssText = "width: 1200px; height: 700px; display: flex;";
  const root = createRoot(container);
  roots.push(root);
  await React.act(() => root.render(element));
  return container;
};

/** Pane ids with their tab ids in tree order, as the reducer tests sketch. */
const sketch = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>(".thread-pane")]
    .map(
      (pane) =>
        `${pane.dataset.pane}[${[
          ...pane.querySelectorAll<HTMLElement>(".pane-tab"),
        ]
          .map((tab) => tab.dataset.tab)
          .join(",")}]`,
    )
    .join(" ");

const tabElement = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`.pane-tab[data-tab="${id}"]`);

const dragEvent = (type: string, init: DragEventInit = {}) =>
  new DragEvent(type, {
    bubbles: true,
    cancelable: true,
    dataTransfer: new DataTransfer(),
    ...init,
  });

/** Drags a tab by its id to a point, through the browser's drag events. */
const dragTabTo = async (
  container: HTMLElement,
  id: string,
  target: Element,
  point: { x: number; y: number },
  drop = true,
) => {
  const source = tabElement(container, id);
  if (source === null) throw new Error(`Tab ${id} did not mount.`);
  await React.act(() => {
    source.dispatchEvent(dragEvent("dragstart"));
  });
  await React.act(() => {
    target.dispatchEvent(
      dragEvent("dragover", { clientX: point.x, clientY: point.y }),
    );
  });
  if (!drop) return;
  await React.act(() => {
    target.dispatchEvent(
      dragEvent("drop", { clientX: point.x, clientY: point.y }),
    );
    source.dispatchEvent(dragEvent("dragend"));
  });
};

const bodyOf = (container: HTMLElement, pane: string) => {
  const body = container.querySelector<HTMLElement>(
    `.thread-pane[data-pane="${pane}"] .pane-body`,
  );
  if (body === null) throw new Error(`Pane ${pane} did not mount.`);
  return body;
};

const fileTarget = (path: string): ThreadPaneFileTarget =>
  ({ kind: "workspace", worktree: "primary", path }) as ThreadPaneFileTarget;

describe("pane tree", () => {
  it("splits a pane when a tab drops on its bottom quarter, previewing the target", async () => {
    const container = await mount(
      <PaneTreeHarness
        main={<div>Agent</div>}
        changes={<div>Changes</div>}
        terminal={<div>Terminal</div>}
        open={["changes", "terminal"]}
      />,
    );
    expect(sketch(container)).toBe("p0[agent] p1[changes,terminal:1]");
    const agentBody = bodyOf(container, "p0");
    const rect = agentBody.getBoundingClientRect();
    await dragTabTo(
      container,
      "terminal:1",
      agentBody,
      { x: rect.left + rect.width / 2, y: rect.bottom - 10 },
      false,
    );
    const preview = container.querySelector<HTMLElement>(".pane-drop-preview");
    expect(preview?.dataset.zone).toBe("bottom");
    await React.act(() => {
      agentBody.dispatchEvent(
        dragEvent("drop", {
          clientX: rect.left + rect.width / 2,
          clientY: rect.bottom - 10,
        }),
      );
    });
    expect(container.querySelector(".pane-drop-preview")).toBeNull();
    expect(sketch(container)).toBe("p0[agent] p2[terminal:1] p1[changes]");
    const column = container.querySelector<HTMLElement>(
      '.pane-split[data-direction="column"]',
    );
    expect(column).not.toBeNull();
    expect(
      column
        ?.querySelector<HTMLElement>(".pane-divider")
        ?.getAttribute("aria-orientation"),
    ).toBe("horizontal");
  });

  it("joins a tab to the pane whose middle or strip it drops on, at the pointer's slot", async () => {
    const container = await mount(
      <PaneTreeHarness
        main={<div>Agent</div>}
        changes={<div>Changes</div>}
        files={<div>Files</div>}
        open={["changes", "files"]}
      />,
    );
    // Middle of the Agent pane: Files joins it after Agent.
    const agentBody = bodyOf(container, "p0");
    const rect = agentBody.getBoundingClientRect();
    await dragTabTo(container, "files", agentBody, {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    });
    expect(sketch(container)).toBe("p0[agent,files] p1[changes]");
    expect(
      tabElement(container, "files")
        ?.querySelector('[role="tab"]')
        ?.getAttribute("aria-selected"),
    ).toBe("true");

    // The strip, before the Agent tab: Changes lands first.
    const strip = container.querySelector<HTMLElement>(
      '.thread-pane[data-pane="p0"] .pane-strip-drop',
    );
    if (strip === null) throw new Error("Strip did not mount.");
    const agentTab = tabElement(container, "agent")?.getBoundingClientRect();
    if (agentTab === undefined) throw new Error("Agent tab did not mount.");
    await dragTabTo(container, "changes", strip, {
      x: agentTab.left + 2,
      y: agentTab.top + 5,
    });
    expect(sketch(container)).toBe("p0[changes,agent,files]");
    expect(container.querySelector(".pane-divider")).toBeNull();
  });

  it("closes others, closes to the right, and closes all from a tab's menu", async () => {
    const container = await mount(
      <PaneTreeHarness
        main={<div>Agent</div>}
        changes={<div>Changes</div>}
        files={<div>Files</div>}
        terminal={<div>Terminal</div>}
        initialLayout={[
          { type: "open-file" as const, target: fileTarget("a.ts") },
          { type: "open-file" as const, target: fileTarget("b.ts") },
        ].reduce(
          reducePaneLayout,
          paneLayoutWith(["changes", "files", "terminal"]),
        )}
      />,
    );
    expect(sketch(container)).toBe(
      "p0[agent] p1[changes,files,terminal:1,file:primary:a.ts,file:primary:b.ts]",
    );
    const menuItem = (label: string) =>
      [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (item) => item.textContent?.trim() === label,
      );
    const openMenu = async (id: string) => {
      const tab = tabElement(container, id);
      await React.act(() => {
        tab?.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            clientX: 10,
            clientY: 10,
          }),
        );
      });
    };
    await openMenu("terminal:1");
    expect(
      [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .map((item) => item.textContent?.trim())
        .slice(0, 4),
    ).toEqual(["Close", "Close Others", "Close to the Right", "Close All"]);
    await React.act(() => menuItem("Close to the Right")?.click());
    expect(sketch(container)).toBe("p0[agent] p1[changes,files,terminal:1]");

    await openMenu("files");
    await React.act(() => menuItem("Close Others")?.click());
    expect(sketch(container)).toBe("p0[agent] p1[files]");

    await openMenu("files");
    await React.act(() => menuItem("Close All")?.click());
    expect(sketch(container)).toBe("p0[agent]");
    // The Agent tab has no menu.
    await openMenu("agent");
    expect(document.querySelector('[role="menuitem"]')).toBeNull();
  });

  it("moves a tab into a new pane beside its own from Move To", async () => {
    const container = await mount(
      <PaneTreeHarness
        main={<div>Agent</div>}
        changes={<div>Changes</div>}
        files={<div>Files</div>}
        open={["changes", "files"]}
      />,
    );
    const tab = tabElement(container, "files");
    await React.act(() => {
      tab?.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          clientX: 10,
          clientY: 10,
        }),
      );
    });
    const moveTo = [
      ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ].find((item) => item.textContent?.trim() === "Move To");
    await React.act(() => {
      moveTo?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
      moveTo?.dispatchEvent(new MouseEvent("pointerenter", { bubbles: true }));
      moveTo?.click();
    });
    const below = await vi.waitFor(() => {
      const item = [
        ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
      ].find((candidate) => candidate.textContent?.trim() === "Below");
      if (item === undefined) throw new Error("Move To did not open.");
      return item;
    });
    await React.act(() => below.click());
    expect(sketch(container)).toBe("p0[agent] p1[changes] p2[files]");
    expect(
      container.querySelector('.pane-split[data-direction="column"]'),
    ).not.toBeNull();
  });

  it("resizes live from the divider without re-rendering the panes' content", async () => {
    const renders = { agent: 0, changes: 0 };
    const Agent = () => {
      renders.agent += 1;
      return <div>Agent</div>;
    };
    const Changes = () => {
      renders.changes += 1;
      return <div>Changes</div>;
    };
    const container = await mount(
      <PaneTreeHarness
        main={<Agent />}
        changes={<Changes />}
        open={["changes"]}
      />,
    );
    const divider = container.querySelector<HTMLElement>(".pane-divider");
    const [left, right] = [
      ...container.querySelectorAll<HTMLElement>(".pane-split-child"),
    ];
    if (divider === null || left === undefined || right === undefined)
      throw new Error("Split did not mount.");
    expect(getComputedStyle(divider).cursor).toBe("ew-resize");
    const before = { ...renders };
    const start = divider.getBoundingClientRect();
    const total =
      left.getBoundingClientRect().width + right.getBoundingClientRect().width;
    divider.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        isPrimary: true,
        pointerId: 1,
        clientX: start.left,
        clientY: start.top + 100,
      }),
    );
    // Live: the DOM moves on each pointer move with no React render.
    divider.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        pointerId: 1,
        clientX: start.left + 120,
        clientY: start.top + 100,
      }),
    );
    const liveLeft = Number.parseFloat(left.style.flexGrow);
    expect(liveLeft).toBeGreaterThan(0.55);
    expect(renders).toEqual(before);
    await React.act(() => {
      divider.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          pointerId: 1,
          clientX: start.left + 120,
          clientY: start.top + 100,
        }),
      );
    });
    // Committed: the layout keeps the size, within a pixel of the live one.
    const committed = Number.parseFloat(left.style.flexGrow);
    expect(Math.abs(committed - liveLeft) * total).toBeLessThan(1);
    expect(right.style.flexGrow).toBe(String(1 - committed));
    expect(renders).toEqual(before);
  });

  it("opens each view once: the Open Tab menu marks it open and brings it forward", async () => {
    const container = await mount(
      <PaneTreeHarness
        main={<div>Agent</div>}
        changes={<div>Changes</div>}
        files={<div>Files</div>}
        open={["changes"]}
      />,
    );
    const openTab = () =>
      [
        ...container.querySelectorAll<HTMLButtonElement>(
          'button[aria-label="Open Tab"]',
        ),
      ].at(-1);
    await React.act(() => openTab()?.click());
    // Each item: its view, and whether it says Open.
    const items = () =>
      [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(
        (item) =>
          `${item.dataset.view}${item.textContent?.includes("Open") ? ":open" : ""}`,
      );
    expect(items()).toEqual(["files", "changes:open"]);
    await React.act(() =>
      [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .find((item) => item.textContent?.includes("Files"))
        ?.click(),
    );
    await React.act(async () => {});
    expect(sketch(container)).toBe("p0[agent] p1[changes,files]");

    // Changes again: no second tab, Changes comes forward.
    await React.act(() => openTab()?.click());
    expect(items()).toEqual(["files:open", "changes:open"]);
    await React.act(() =>
      [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .find((item) => item.textContent?.includes("Changes"))
        ?.click(),
    );
    await React.act(async () => {});
    expect(sketch(container)).toBe("p0[agent] p1[changes,files]");
    expect(
      tabElement(container, "changes")
        ?.querySelector('[role="tab"]')
        ?.getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("truncates a long file name and keeps its close button inside the tab", async () => {
    const longName =
      "settings-behavior-workspace-extension-configuration-reference-notes.md";
    const container = await mount(
      <PaneTreeHarness
        main={<div>Agent</div>}
        files={<div>Files</div>}
        initialLayout={reducePaneLayout(paneLayoutWith(["files"]), {
          type: "open-file",
          target: fileTarget(`docs/${longName}`),
        })}
      />,
    );
    const tab = tabElement(container, `file:primary:docs/${longName}`);
    const label = tab?.querySelector<HTMLElement>(".pane-tab-label");
    const close = tab?.querySelector<HTMLElement>(".pane-tab-close");
    if (!tab || !label || !close) throw new Error("File tab did not mount.");
    const tabRect = tab.getBoundingClientRect();
    expect(tabRect.width).toBeLessThanOrEqual(208);
    expect(label.scrollWidth).toBeGreaterThan(label.clientWidth);
    expect(getComputedStyle(label).textOverflow).toBe("ellipsis");
    const closeRect = close.getBoundingClientRect();
    expect(closeRect.right).toBeLessThanOrEqual(tabRect.right + 0.5);
    expect(closeRect.width).toBeGreaterThan(0);
    expect(tab.querySelector('[role="tab"]')?.getAttribute("title")).toBe(
      `docs/${longName}`,
    );
  });

  it("scrolls the strip when tabs overflow instead of squeezing them", async () => {
    const files = Array.from({ length: 12 }, (_, index) =>
      fileTarget(`src/module-${index}.ts`),
    );
    const container = await mount(
      <div style={{ width: 420, height: 400, display: "flex" }}>
        <PaneTreeHarness
          main={<div>Agent</div>}
          files={<div>Files</div>}
          initialLayout={files
            .map((target) => ({ type: "open-file" as const, target }))
            .reduce(reducePaneLayout, paneLayoutWith(["files"]))}
        />
      </div>,
    );
    const strip = container.querySelector<HTMLElement>(
      '.thread-pane[data-pane="p1"] .pane-tabs',
    );
    if (strip === null) throw new Error("Strip did not mount.");
    // Every label is whole: no tab squeezed to an ellipsis.
    const clipped = [
      ...strip.querySelectorAll<HTMLElement>(".pane-tab-label"),
    ].filter((label) => label.scrollWidth > label.clientWidth);
    expect(clipped).toHaveLength(0);
    expect(strip.scrollWidth).toBeGreaterThan(strip.clientWidth);
    expect(getComputedStyle(strip).overflowX).toBe("auto");
    // The shown tab is scrolled into view.
    const active = strip.querySelector<HTMLElement>(".pane-tab[data-active]");
    await vi.waitFor(() => {
      const rect = active?.getBoundingClientRect();
      const stripRect = strip.getBoundingClientRect();
      if (!rect) throw new Error("Active tab did not mount.");
      expect(rect.right).toBeLessThanOrEqual(stripRect.right + 1);
    });
    // A vertical wheel over the strip scrolls it sideways.
    const before = strip.scrollLeft;
    strip.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY: -120,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(strip.scrollLeft).toBeLessThan(before);
  });
});
