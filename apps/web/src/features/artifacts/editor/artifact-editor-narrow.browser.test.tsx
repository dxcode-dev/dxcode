/**
 * The artifact editor on a phone and on a desktop: its toolbar and a wide
 * table (the owner's report from an iPhone, about 390 px wide).
 *
 * Ways it can fail, each covered below:
 *  1. Toolbar buttons shrink below their content, so their labels overlap
 *     and cannot be read.
 *  2. A button that shows only its icon loses its name, so a screen reader
 *     or a long press cannot tell what it does.
 *  3. Buttons pushed past the edge cannot be reached: the toolbar neither
 *     fits nor scrolls.
 *  4. A wide table squeezes its columns until each word wraps on its own
 *     line, instead of scrolling sideways inside its box.
 *  5. A wide table makes the whole page scroll sideways.
 *  6. On a desktop the labels disappear, though there is room for them.
 *  7. On a desktop, the Artifacts pane beside the conversation (about
 *     590 px at 1440) no longer fits every tool, as it did before, so the
 *     last ones scroll out of sight; also with the dictation mic first in
 *     the toolbar (seen on staging after #1773).
 *
 * Insert Image and Wide Layout are icons on every screen, as in the
 * reference editor's toolbar (#1810); in that pane the table tools are
 * icons too, the cell grips (#1809) being where tables are edited.
 */
import type { ThreadArtifact } from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import { QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import "../../../styles.css";
import "../artifacts-view.css";
import { AuthContext } from "../../../shared/auth/auth-context.js";
import { createQueryClient } from "../../../shared/query/query-client.js";
import {
  InsertDictation,
  TextareaDictation,
} from "../../threads/dictation/use-dictation.js";
import { ArtifactEditor } from "./artifact-editor.js";

/** The mic the Thread page passes down when dictation is available. */
const micSlot = { Insert: InsertDictation, Textarea: TextareaDictation };

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const threadId = "thr_00000000-0000-4000-8000-0000000000c3" as ThreadId;
const userId = "usr_narrow" as UserId;

const artifact = (): ThreadArtifact => ({
  id: `art_${"c".repeat(32)}`,
  threadId,
  folder: "",
  title: "Release checklist",
  revision: 1,
  sizeBytes: 0,
  createdBy: { kind: "agent" },
  updatedBy: { kind: "agent" },
  openCommentCount: 0,
  createdAt: 0,
  updatedAt: 0,
});

/** Five columns of sentences, as an agent writes a status table. */
const TABLE = [
  "Intro.",
  "",
  "| Area | Owner | Status | Next step | Notes |",
  "| --- | --- | --- | --- | --- |",
  "| Billing export | Finance team | Blocked on the vendor | Ask for the new API key | The old key expired last week |",
  "| Phone layout | Web team | In review | Merge after the preview passes | Screenshots attached to the pull request |",
  "",
].join("\n");

let root: Root | undefined;
afterEach(async () => {
  await React.act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  await page.viewport(1280, 800);
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

/** The editor at `width` with the caret in the table, so its tools show. */
const mount = async (width: number, pane?: number, mic = false) => {
  await page.viewport(width, 844);
  document.body.style.margin = "0";
  vi.stubGlobal("fetch", () => new Promise<Response>(() => {}));
  const container = document.body.appendChild(document.createElement("div"));
  container.style.height = "844px";
  container.style.display = "flex";
  if (pane !== undefined) container.style.width = `${pane}px`;
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
            initial={{ artifact: artifact(), markdown: TABLE }}
            readOnly={false}
            switcher={null}
            dictation={mic ? micSlot : undefined}
          />
        </AuthContext>
      </QueryClientProvider>,
    ),
  );
  const cell = container.querySelector<HTMLElement>(".artifact-prose td");
  if (cell === null) throw new Error("Expected the table.");
  await userEvent.click(cell);
  await settle();
  const toolbar = container.querySelector<HTMLElement>(".artifact-toolbar");
  if (toolbar === null) throw new Error("Expected the toolbar.");
  return { container, toolbar };
};

/** Icons on every screen, as in the reference editor's toolbar. */
const ICON_ONLY = new Set(["Insert Image", "Wide Layout"]);

const NAMES = [
  "Table",
  "Insert Image",
  "Checklist",
  "Insert",
  "Comment",
  "Add Row",
  "Add Column",
  "Row Options",
  "Wide Layout",
];

/** Each tool's accessible name, in order, as a screen reader hears it. */
const tools = (toolbar: HTMLElement) =>
  [...toolbar.querySelectorAll<HTMLElement>(".artifact-tool")].map(
    (element) => ({
      element,
      name:
        element.getAttribute("aria-label") ?? element.textContent?.trim() ?? "",
    }),
  );

const overlaps = (toolbar: HTMLElement) => {
  const found: string[] = [];
  const list = tools(toolbar);
  for (const [index, { element, name }] of list.entries()) {
    // Content wider than the button spills over its neighbour.
    if (element.scrollWidth > element.clientWidth + 1)
      found.push(`${name} spills out of its button`);
    const next = list[index + 1];
    if (
      next !== undefined &&
      element.getBoundingClientRect().right >
        next.element.getBoundingClientRect().left + 0.5
    )
      found.push(`${name} overlaps ${next.name}`);
  }
  return found;
};

describe.each([390, 360])("on a %i px phone", (width) => {
  it("shows every tool without overlap, each still named, all reachable", async () => {
    const { toolbar } = await mount(width);
    expect(tools(toolbar).map(({ name }) => name)).toEqual(NAMES);
    expect(overlaps(toolbar)).toEqual([]);
    // Icon-only: each named button is no wider than a tap target and a gap.
    for (const { element, name } of tools(toolbar))
      expect(
        element.getBoundingClientRect().width,
        `${name} is icon-only`,
      ).toBeLessThanOrEqual(56);
    // The last tool is on screen or the toolbar scrolls to it.
    const last = toolbar.querySelector<HTMLElement>(
      ".artifact-tool:last-child",
    );
    const fits = toolbar.scrollWidth <= toolbar.clientWidth;
    const scrolls = getComputedStyle(toolbar).overflowX === "auto";
    expect(fits || scrolls).toBe(true);
    toolbar.scrollLeft = toolbar.scrollWidth;
    expect(last?.getBoundingClientRect().right).toBeLessThanOrEqual(width);
  });

  it("scrolls a wide table sideways inside its box, with readable columns", async () => {
    const { container } = await mount(width);
    const scroll = container.querySelector<HTMLElement>(
      ".artifact-table-scroll",
    );
    if (scroll === null) throw new Error("Expected the table box.");
    const cells = [
      ...container.querySelectorAll<HTMLElement>(".artifact-prose th"),
    ];
    const widths = cells.map((cell) =>
      Math.round(cell.getBoundingClientRect().width),
    );
    for (const [index, cellWidth] of widths.entries())
      expect(
        cellWidth,
        `column ${index + 1} is readable`,
      ).toBeGreaterThanOrEqual(120);
    expect(scroll.scrollWidth).toBeGreaterThan(scroll.clientWidth);
    expect(getComputedStyle(scroll).overflowX).toBe("auto");
    // The page itself does not scroll sideways.
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  });
});

describe("on a 1440 px desktop", () => {
  it("fits every tool in the Artifacts pane beside the conversation, the table tools as icons", async () => {
    const { toolbar } = await mount(1440, 590);
    expect(overlaps(toolbar)).toEqual([]);
    expect(toolbar.scrollWidth).toBeLessThanOrEqual(toolbar.clientWidth);
    expect(tools(toolbar).map(({ name }) => name)).toEqual(NAMES);
    for (const name of ["Table", "Checklist", "Insert", "Comment"]) {
      const element = tools(toolbar).find(
        (tool) => tool.name === name,
      )?.element;
      expect(
        element?.querySelector("span")?.getBoundingClientRect().width,
        `${name} label shows`,
      ).toBeGreaterThan(20);
    }
  });

  it("fits every tool in that pane with the dictation mic first, the table tools as icons", async () => {
    const { toolbar } = await mount(1440, 590, true);
    expect(
      toolbar.querySelector('[aria-label="Start dictation"]'),
    ).not.toBeNull();
    expect(overlaps(toolbar)).toEqual([]);
    expect(toolbar.scrollWidth).toBeLessThanOrEqual(toolbar.clientWidth);
    // Still named, and the tools before them keep their labels.
    expect(tools(toolbar).map(({ name }) => name)).toEqual(NAMES);
    for (const name of ["Table", "Checklist", "Insert", "Comment"]) {
      const element = tools(toolbar).find(
        (tool) => tool.name === name,
      )?.element;
      expect(
        element?.querySelector("span")?.getBoundingClientRect().width,
        `${name} label shows`,
      ).toBeGreaterThan(20);
    }
  });

  it("keeps every tool's label beside its icon, with no overlap", async () => {
    const { toolbar } = await mount(1440);
    expect(tools(toolbar).map(({ name }) => name)).toEqual(NAMES);
    expect(overlaps(toolbar)).toEqual([]);
    for (const { element, name } of tools(toolbar)) {
      if (ICON_ONLY.has(name)) continue;
      const label = element.querySelector("span");
      expect(
        label?.getBoundingClientRect().width,
        `${name} label shows`,
      ).toBeGreaterThan(20);
    }
  });
});
