import type { ThreadPaneFileTarget, ThreadPaneLayout } from "@dx/api";
import { describe, expect, it } from "vitest";
import { paneLayoutWith } from "../../../testing/pane-layouts.js";
import {
  defaultPaneLayout,
  flattenPaneTabs,
  listPanes,
  paneOf,
  reducePaneLayout,
  repairPaneLayout,
  tabId,
  tabLabel,
} from "./pane-layout.js";

const file = (path: string): ThreadPaneFileTarget =>
  ({ kind: "workspace", worktree: "primary", path }) as ThreadPaneFileTarget;

const run = (
  layout: ThreadPaneLayout,
  ...actions: Parameters<typeof reducePaneLayout>[1][]
) => actions.reduce(reducePaneLayout, layout);

/** Pane ids with their tab ids, in tree order: `p1[agent] p2[files,changes]`. */
const sketch = (layout: ThreadPaneLayout) =>
  listPanes(layout)
    .map((pane) => `${pane.id}[${pane.tabs.map(tabId).join(",")}]`)
    .join(" ");

const sizesOf = (layout: ThreadPaneLayout) =>
  layout.root.kind === "split" ? layout.root.sizes : undefined;

const activeTabOf = (layout: ThreadPaneLayout, pane: string) => {
  const found = paneOf(layout, pane);
  const tab = found?.tabs[found.active];
  return tab === undefined ? undefined : tabId(tab);
};

describe("pane layout reducer", () => {
  it("starts with one pane holding the Agent", () => {
    const layout = defaultPaneLayout();
    expect(sketch(layout)).toBe("p0[agent]");
    expect(layout.focused).toBe("p0");
  });

  it("opens the first view in a new right-hand pane at half width and focuses it", () => {
    const layout = run(defaultPaneLayout(), {
      type: "open-view",
      view: "files",
    });
    expect(sketch(layout)).toBe("p0[agent] p1[files]");
    expect(layout.root.kind).toBe("split");
    if (layout.root.kind !== "split") throw new Error("expected split");
    expect(layout.root.direction).toBe("row");
    expect(layout.root.sizes).toEqual([0.5, 0.5]);
    expect(layout.focused).toBe("p1");
  });

  it("opens later views as tabs in the focused view pane, active", () => {
    const layout = run(
      defaultPaneLayout(),
      { type: "open-view", view: "files" },
      { type: "open-view", view: "changes" },
      { type: "open-view", view: "terminal" },
    );
    expect(sketch(layout)).toBe("p0[agent] p1[files,changes,terminal:1]");
    expect(paneOf(layout, "p1")?.active).toBe(2);
  });

  it("activates an open singleton view instead of opening it twice", () => {
    const opened = run(
      defaultPaneLayout(),
      { type: "open-view", view: "files" },
      { type: "open-view", view: "changes" },
    );
    const again = reducePaneLayout(opened, {
      type: "open-view",
      view: "files",
    });
    expect(sketch(again)).toBe("p0[agent] p1[files,changes]");
    expect(paneOf(again, "p1")?.active).toBe(0);
    // Already active and focused: the same object comes back.
    expect(reducePaneLayout(again, { type: "open-view", view: "files" })).toBe(
      again,
    );
  });

  it("keeps one Terminal: opening it again activates the existing tab", () => {
    const layout = run(
      defaultPaneLayout(),
      { type: "open-view", view: "terminal" },
      { type: "open-view", view: "files" },
      { type: "open-view", view: "terminal" },
    );
    expect(sketch(layout)).toBe("p0[agent] p1[terminal:1,files]");
    expect(paneOf(layout, "p1")?.active).toBe(0);
    expect(paneOf(layout, "p1")?.tabs.map(tabLabel)[0]).toBe("Terminal");
  });

  it("opens a view into the pane whose Open Tab menu asked for it", () => {
    const layout = run(
      defaultPaneLayout(),
      { type: "open-view", view: "files" },
      { type: "open-view", view: "changes", pane: "p0" },
    );
    expect(sketch(layout)).toBe("p0[agent,changes] p1[files]");
    expect(paneOf(layout, "p0")?.active).toBe(1);
    expect(layout.focused).toBe("p0");
  });

  it("opens a file beside Files when Files is open, otherwise in the view pane", () => {
    const beside = run(
      defaultPaneLayout(),
      { type: "open-view", view: "changes" },
      { type: "open-view", view: "files", pane: "p0" },
      { type: "open-file", target: file("src/a.ts") },
    );
    expect(sketch(beside)).toBe(
      "p0[agent,files,file:primary:src/a.ts] p1[changes]",
    );
    const viewPane = run(
      defaultPaneLayout(),
      { type: "open-view", view: "changes" },
      { type: "open-file", target: file("src/a.ts") },
    );
    expect(sketch(viewPane)).toBe(
      "p0[agent] p1[changes,file:primary:src/a.ts]",
    );
    const first = run(defaultPaneLayout(), {
      type: "open-file",
      target: file("README.md"),
    });
    expect(sketch(first)).toBe("p0[agent] p1[file:primary:README.md]");
    expect(paneOf(first, "p1")?.tabs.map(tabLabel)[0]).toBe("README.md");
  });

  it("reopening an open file activates it without a second tab", () => {
    const layout = run(
      defaultPaneLayout(),
      { type: "open-file", target: file("a.ts") },
      { type: "open-file", target: file("b.ts") },
      { type: "open-file", target: file("a.ts") },
    );
    expect(sketch(layout)).toBe(
      "p0[agent] p1[file:primary:a.ts,file:primary:b.ts]",
    );
    expect(paneOf(layout, "p1")?.active).toBe(0);
  });

  it("closing the active tab returns to the tab active before it", () => {
    // #1113: Files, then Changes, Terminal, Desktop; a file opened from Files.
    const opened = run(
      paneLayoutWith(["files", "changes", "terminal", "desktop"]),
      { type: "open-file", target: file("README.md") },
    );
    expect(sketch(opened)).toBe(
      "p0[agent] p1[files,changes,terminal:1,desktop,file:primary:README.md]",
    );
    const closed = reducePaneLayout(opened, {
      type: "close",
      tab: "file:primary:README.md",
    });
    expect(sketch(closed)).toBe(
      "p0[agent] p1[files,changes,terminal:1,desktop]",
    );
    expect(activeTabOf(closed, "p1")).toBe("files");
  });

  it("walks back through earlier active tabs as they close, skipping closed ones", () => {
    const layout = run(
      defaultPaneLayout(),
      { type: "open-view", view: "files" },
      { type: "open-view", view: "changes" },
      { type: "open-view", view: "terminal" },
      { type: "activate", pane: "p1", tab: "files" },
      { type: "open-file", target: file("a.ts") },
      { type: "activate", pane: "p1", tab: "changes" },
      { type: "open-file", target: file("b.ts") },
    );
    // Closing a tab that is not shown leaves the shown tab alone.
    const closedHidden = reducePaneLayout(layout, {
      type: "close",
      tab: "changes",
    });
    expect(activeTabOf(closedHidden, "p1")).toBe("file:primary:b.ts");
    const order = ["file:primary:b.ts", "file:primary:a.ts", "files"];
    let current = closedHidden;
    for (const [index, id] of order.entries()) {
      current = reducePaneLayout(current, { type: "close", tab: id });
      expect(activeTabOf(current, "p1")).toBe(
        index === 0
          ? "file:primary:a.ts"
          : index === 1
            ? "files"
            : "terminal:1",
      );
    }
  });

  it("keeps the earlier active tab across a reorder and a move to another pane", () => {
    const base = run(
      defaultPaneLayout(),
      { type: "open-view", view: "files" },
      { type: "open-view", view: "changes" },
      { type: "open-view", view: "terminal" },
      { type: "activate", pane: "p1", tab: "files" },
      { type: "open-file", target: file("a.ts") },
    );
    // Reordering Files to the end shifts every index after it.
    const reordered = run(
      base,
      { type: "move", tab: "files", to: { pane: "p1" } },
      { type: "activate", pane: "p1", tab: "file:primary:a.ts" },
    );
    expect(sketch(reordered)).toBe(
      "p0[agent] p1[changes,terminal:1,file:primary:a.ts,files]",
    );
    expect(
      activeTabOf(
        reducePaneLayout(reordered, {
          type: "close",
          tab: "file:primary:a.ts",
        }),
        "p1",
      ),
    ).toBe("files");
    // Dragging the shown tab into the Agent pane leaves its pane on the
    // tab shown before it.
    const moved = reducePaneLayout(base, {
      type: "move",
      tab: "file:primary:a.ts",
      to: { pane: "p0" },
    });
    expect(sketch(moved)).toBe(
      "p0[agent,file:primary:a.ts] p1[files,changes,terminal:1]",
    );
    expect(activeTabOf(moved, "p1")).toBe("files");
    expect(activeTabOf(moved, "p0")).toBe("file:primary:a.ts");
  });

  it("closing the active tab with no earlier one shows its right-hand neighbour, or the last tab", () => {
    // A layout saved before panes remembered earlier tabs.
    const three: ThreadPaneLayout = {
      version: 1,
      root: {
        kind: "split",
        id: "s1",
        direction: "row",
        children: [
          { kind: "pane", id: "p0", tabs: [{ kind: "agent" }], active: 0 },
          {
            kind: "pane",
            id: "p1",
            tabs: [
              { kind: "files" },
              { kind: "changes" },
              { kind: "terminal", ordinal: 1 },
            ],
            active: 1,
          },
        ],
        sizes: [0.5, 0.5],
      },
      focused: "p1",
      nextPane: 2,
      nextTerminal: 2,
    };
    const closedMiddle = reducePaneLayout(three, {
      type: "close",
      tab: "changes",
    });
    expect(sketch(closedMiddle)).toBe("p0[agent] p1[files,terminal:1]");
    expect(paneOf(closedMiddle, "p1")?.active).toBe(1);
    const closedLast = reducePaneLayout(closedMiddle, {
      type: "close",
      tab: "terminal:1",
    });
    expect(paneOf(closedLast, "p1")?.active).toBe(0);
  });

  it("repairs earlier-tab indices a saved layout no longer fits", () => {
    const saved = paneLayoutWith(["files", "changes"]);
    if (saved.root.kind !== "split") throw new Error("expected split");
    const broken: ThreadPaneLayout = {
      ...saved,
      root: {
        ...saved.root,
        children: [
          saved.root.children[0] as ThreadPaneLayout["root"],
          {
            kind: "pane",
            id: "p1",
            tabs: [{ kind: "files" }, { kind: "changes" }],
            active: 0,
            recent: [0, 7, 1, 1],
          },
        ],
      },
    };
    const repaired = repairPaneLayout(broken);
    expect(paneOf(repaired, "p1")?.recent).toEqual([1]);
    expect(
      activeTabOf(
        reducePaneLayout(repaired, { type: "close", tab: "files" }),
        "p1",
      ),
    ).toBe("changes");
  });

  it("closing the last tab removes the pane and its split, and refocuses", () => {
    const layout = run(
      defaultPaneLayout(),
      { type: "open-view", view: "files" },
      { type: "close", tab: "files" },
    );
    expect(sketch(layout)).toBe("p0[agent]");
    expect(layout.root.kind).toBe("pane");
    expect(layout.focused).toBe("p0");
  });

  it("never closes the Agent tab", () => {
    const base = run(
      defaultPaneLayout(),
      { type: "open-view", view: "files", pane: "p0" },
      { type: "open-view", view: "changes", pane: "p0" },
    );
    expect(reducePaneLayout(base, { type: "close", tab: "agent" })).toBe(base);
    expect(
      sketch(reducePaneLayout(base, { type: "close-all", pane: "p0" })),
    ).toBe("p0[agent]");
    expect(
      sketch(
        reducePaneLayout(base, {
          type: "close-others",
          pane: "p0",
          tab: "files",
        }),
      ),
    ).toBe("p0[agent,files]");
  });

  it("closes others and closes to the right", () => {
    const base = run(
      defaultPaneLayout(),
      { type: "open-view", view: "files" },
      { type: "open-file", target: file("a.ts") },
      { type: "open-file", target: file("b.ts") },
      { type: "open-view", view: "changes" },
    );
    expect(sketch(base)).toBe(
      "p0[agent] p1[files,file:primary:a.ts,file:primary:b.ts,changes]",
    );
    const others = reducePaneLayout(base, {
      type: "close-others",
      pane: "p1",
      tab: "file:primary:a.ts",
    });
    expect(sketch(others)).toBe("p0[agent] p1[file:primary:a.ts]");
    expect(paneOf(others, "p1")?.active).toBe(0);
    const right = reducePaneLayout(base, {
      type: "close-right",
      pane: "p1",
      tab: "file:primary:a.ts",
    });
    expect(sketch(right)).toBe("p0[agent] p1[files,file:primary:a.ts]");
    // The active tab (changes) was closed: the target stays shown.
    expect(paneOf(right, "p1")?.active).toBe(1);
    expect(
      sketch(reducePaneLayout(base, { type: "close-all", pane: "p1" })),
    ).toBe("p0[agent]");
  });

  it("joins a tab to another pane and drops the emptied source pane", () => {
    const base = run(
      defaultPaneLayout(),
      { type: "open-view", view: "files" },
      { type: "open-view", view: "changes" },
    );
    const joined = reducePaneLayout(base, {
      type: "move",
      tab: "files",
      to: { pane: "p0" },
    });
    expect(sketch(joined)).toBe("p0[agent,files] p1[changes]");
    expect(paneOf(joined, "p0")?.active).toBe(1);
    expect(joined.focused).toBe("p0");
    const emptied = reducePaneLayout(joined, {
      type: "move",
      tab: "changes",
      to: { pane: "p0", index: 0 },
    });
    expect(sketch(emptied)).toBe("p0[changes,agent,files]");
    expect(emptied.root.kind).toBe("pane");
  });

  it("reorders within a pane by moving to an index", () => {
    const base = run(
      defaultPaneLayout(),
      { type: "open-view", view: "files" },
      { type: "open-view", view: "changes" },
      { type: "open-view", view: "terminal" },
    );
    const moved = reducePaneLayout(base, {
      type: "move",
      tab: "terminal:1",
      to: { pane: "p1", index: 0 },
    });
    expect(sketch(moved)).toBe("p0[agent] p1[terminal:1,files,changes]");
    const toEnd = reducePaneLayout(moved, {
      type: "move",
      tab: "terminal:1",
      to: { pane: "p1", index: 3 },
    });
    expect(sketch(toEnd)).toBe("p0[agent] p1[files,changes,terminal:1]");
  });

  it("splits a pane when a tab drops on its edge", () => {
    const base = run(
      defaultPaneLayout(),
      { type: "open-view", view: "files" },
      { type: "open-view", view: "changes" },
    );
    const below = reducePaneLayout(base, {
      type: "move",
      tab: "changes",
      to: { pane: "p0", side: "bottom" },
    });
    expect(sketch(below)).toBe("p0[agent] p2[changes] p1[files]");
    if (below.root.kind !== "split") throw new Error("expected split");
    const left = below.root.children[0];
    expect(left?.kind).toBe("split");
    if (left?.kind !== "split") throw new Error("expected column");
    expect(left.direction).toBe("column");
    expect(left.sizes).toEqual([0.5, 0.5]);
    expect(below.focused).toBe("p2");

    // Dropping on the left edge of the Agent pane in a row inserts a sibling
    // that shares the Agent pane's width, with no nested row.
    const leftOfAgent = reducePaneLayout(base, {
      type: "move",
      tab: "changes",
      to: { pane: "p0", side: "left" },
    });
    expect(sketch(leftOfAgent)).toBe("p2[changes] p0[agent] p1[files]");
    expect(sizesOf(leftOfAgent)).toEqual([0.25, 0.25, 0.5]);
  });

  it("ignores dropping a pane's only tab onto its own pane", () => {
    const base = run(defaultPaneLayout(), { type: "open-view", view: "files" });
    expect(
      reducePaneLayout(base, {
        type: "move",
        tab: "files",
        to: { pane: "p1" },
      }),
    ).toBe(base);
    expect(
      reducePaneLayout(base, {
        type: "move",
        tab: "files",
        to: { pane: "p1", side: "top" },
      }),
    ).toBe(base);
  });

  it("merges nested splits that run in the same direction", () => {
    const base = run(
      defaultPaneLayout(),
      { type: "open-view", view: "files" },
      { type: "open-view", view: "changes" },
      { type: "move", tab: "changes", to: { pane: "p0", side: "bottom" } },
      // Terminal below Changes: the column gains a third child, not a column
      // inside a column.
      { type: "open-view", view: "terminal", pane: "p2" },
      { type: "move", tab: "terminal:1", to: { pane: "p2", side: "bottom" } },
    );
    expect(sketch(base)).toBe("p0[agent] p2[changes] p3[terminal:1] p1[files]");
    if (base.root.kind !== "split") throw new Error("expected split");
    const column = base.root.children[0];
    if (column?.kind !== "split") throw new Error("expected column");
    expect(column.children.map((child) => child.kind)).toEqual([
      "pane",
      "pane",
      "pane",
    ]);
    expect(column.sizes.map((size) => Math.round(size * 100))).toEqual([
      50, 25, 25,
    ]);
  });

  it("resizes a split, clamping each child to a minimum share", () => {
    const base = run(defaultPaneLayout(), { type: "open-view", view: "files" });
    if (base.root.kind !== "split") throw new Error("expected split");
    const resized = reducePaneLayout(base, {
      type: "resize",
      split: base.root.id,
      sizes: [0.7, 0.3],
    });
    expect(sizesOf(resized)).toEqual([0.7, 0.3]);
    const clamped = reducePaneLayout(base, {
      type: "resize",
      split: base.root.id,
      sizes: [0.99, 0.01],
    });
    const sizes = sizesOf(clamped) ?? [];
    expect(sizes[1]).toBeGreaterThanOrEqual(0.1);
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBeCloseTo(1);
    expect(
      reducePaneLayout(base, { type: "resize", split: "nope", sizes: [1, 0] }),
    ).toBe(base);
  });

  it("repairs a layout from another device that no longer fits", () => {
    const stale = {
      version: 1,
      focused: "gone",
      nextPane: 1,
      nextTerminal: 1,
      root: {
        kind: "split",
        id: "s",
        direction: "row",
        sizes: [0.5, 0.5],
        children: [
          { kind: "pane", id: "p0", tabs: [{ kind: "agent" }], active: 7 },
          { kind: "pane", id: "p1", tabs: [], active: 0 },
        ],
      },
    } satisfies ThreadPaneLayout;
    const repaired = repairPaneLayout(stale);
    expect(sketch(repaired)).toBe("p0[agent]");
    expect(repaired.focused).toBe("p0");
    expect(paneOf(repaired, "p0")?.active).toBe(0);
    // A layout without the Agent tab gets one.
    const missingAgent = repairPaneLayout({
      ...stale,
      root: { kind: "pane", id: "p0", tabs: [{ kind: "files" }], active: 0 },
    });
    expect(sketch(missingAgent)).toBe("p0[agent,files]");
    // Pane ids below `nextPane` are never reused.
    const next = reducePaneLayout(missingAgent, {
      type: "open-view",
      view: "changes",
    });
    expect(listPanes(next).map((pane) => pane.id)).toEqual(["p0", "p1"]);
  });

  it("flattens tabs for the stacked layout with the Agent first", () => {
    const layout = run(
      defaultPaneLayout(),
      { type: "open-view", view: "files" },
      { type: "open-view", view: "changes" },
      { type: "move", tab: "changes", to: { pane: "p0", side: "left" } },
    );
    expect(flattenPaneTabs(layout).map((entry) => tabId(entry.tab))).toEqual([
      "agent",
      "changes",
      "files",
    ]);
    expect(flattenPaneTabs(layout).map((entry) => entry.pane)).toEqual([
      "p0",
      "p2",
      "p1",
    ]);
  });

  it("focuses a pane and ignores one that does not exist", () => {
    const base = run(defaultPaneLayout(), { type: "open-view", view: "files" });
    expect(reducePaneLayout(base, { type: "focus", pane: "p0" }).focused).toBe(
      "p0",
    );
    expect(reducePaneLayout(base, { type: "focus", pane: "p9" })).toBe(base);
  });
});
