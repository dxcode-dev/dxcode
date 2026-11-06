/**
 * Table grips match reference capture #1801 (#1809).
 * Failure cases: a right-click acts on the old cell; insertions use the wrong
 * side or lose text/alignment; a phone cannot reach the controls; leaving a
 * table/read-only mode still exposes mutation tools; saved GFM loses edits.
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
import { ArtifactEditor } from "./artifact-editor.js";

const threadId = "thr_00000000-0000-4000-8000-0000000000a9" as ThreadId;
const userId = "usr_table_tools" as UserId;
const artifact: ThreadArtifact = {
  id: `art_${"9".repeat(32)}`,
  threadId,
  folder: "",
  title: "Launch checklist",
  revision: 1,
  sizeBytes: 0,
  createdBy: { kind: "agent" },
  updatedBy: { kind: "agent" },
  openCommentCount: 0,
  createdAt: 0,
  updatedAt: 0,
};
const markdown =
  "Intro.\n\n| Step | Owner | Status |\n| :--- | :---: | ---: |\n| Edit | Web | Ready |\n| Review | QA | Done |\n\nAfter.\n";
let root: Root | undefined;
afterEach(async () => {
  await React.act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  await page.viewport(1280, 800);
});
/** The Markdown each artifact's editor last saved, by artifact id. */
const saves = new Map<string, string>();
let mounts = 0;
/** The artifact the test's editor shows. */
let shown = artifact;
/** What the editor now on screen saved: no other editor's save counts. */
const saved = () => saves.get(shown.id) ?? "";
const mount = async (width: number, readOnly = false, source = markdown) => {
  await page.viewport(width, 844);
  // Each editor edits its own artifact, and a test reads only its editor's
  // saves. An editor a test left behind can still save after the test ends:
  // twice in release runs, the Markdown a round trip checked matched an
  // earlier test's last edit.
  mounts += 1;
  shown = { ...artifact, id: `art_${mounts.toString(16).padStart(32, "0")}` };
  // Saves succeed, answered as the server answers them. An answer the editor
  // cannot read is a failed save, which it retries for as long as the page
  // lives.
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "PUT" && typeof init.body === "string") {
      const id = decodeURIComponent(String(input).split("/").at(-1) ?? "");
      const body = JSON.parse(init.body) as {
        markdown: string;
        baseRevision: number;
      };
      saves.set(id, body.markdown);
      return Promise.resolve(
        Response.json({
          status: "success",
          data: {
            artifact: {
              ...artifact,
              id,
              revision: body.baseRevision + 1,
              sizeBytes: body.markdown.length,
            },
            markdown: body.markdown,
          },
        }),
      );
    }
    return new Promise<Response>(() => {});
  });
  const container = document.body.appendChild(document.createElement("div"));
  container.style.cssText = "height:800px;display:flex";
  root = createRoot(container);
  await React.act(() =>
    root?.render(
      <QueryClientProvider client={createQueryClient()}>
        <AuthContext
          value={{
            identity: { id: userId, name: "Web", email: "w@dx.test" },
            logout: () => undefined,
          }}
        >
          <ArtifactEditor
            threadId={threadId}
            initial={{ artifact: shown, markdown: source }}
            readOnly={readOnly}
            switcher={null}
          />
        </AuthContext>
      </QueryClientProvider>,
    ),
  );
  const prose = container.querySelector<HTMLElement>(".artifact-prose");
  if (!prose) throw new Error("Missing editor");
  return prose;
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 70));
const tools = () =>
  document.querySelector<HTMLElement>(".artifact-table-tools");
const button = (label: string) => {
  const element = tools()?.querySelector<HTMLElement>(
    `[aria-label="${label}"]`,
  );
  if (!element) throw new Error(`Missing table tool ${label}`);
  return element;
};
const choose = async (menu: string, label: string) => {
  await userEvent.click(button(menu));
  await settle();
  await userEvent.click(
    page.getByRole("menuitem", { name: label, exact: true }),
  );
  await expect
    .poll(() => document.activeElement?.classList.contains("artifact-prose"))
    .toBe(true);
  await settle();
};
const cells = (prose: HTMLElement) =>
  [...(prose.querySelector("table")?.rows ?? [])].map((row) =>
    [...row.cells].map((cell) => cell.textContent),
  );
const target = (prose: HTMLElement, row: number, column: number) => {
  const cell = prose.querySelector("table")?.rows[row]?.cells[column];
  if (!cell) throw new Error("Missing cell");
  return cell;
};
const rightClick = async (element: HTMLElement) => {
  const box = element.getBoundingClientRect();
  await React.act(() =>
    element.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: box.left + 12,
        clientY: box.top + 10,
        button: 2,
      }),
    ),
  );
  await settle();
};

describe.each([1440, 390])("table grips at %i", (width) => {
  it("targets a right-clicked cell and inserts columns on either side", async () => {
    const prose = await mount(width);
    await userEvent.click(prose.querySelector("p") as HTMLElement);
    await rightClick(target(prose, 1, 1));
    expect(tools()).not.toBeNull();
    await choose("Column Options", "Insert Left");
    expect(cells(prose)).toEqual([
      ["Step", "", "Owner", "Status"],
      ["Edit", "", "Web", "Ready"],
      ["Review", "", "QA", "Done"],
    ]);
    await userEvent.keyboard("Inserted");
    expect(
      target(prose, 1, 1).textContent,
      JSON.stringify({
        cells: cells(prose),
        focused: document.activeElement?.outerHTML.slice(0, 300),
        selection: getSelection()?.anchorNode?.parentElement?.outerHTML.slice(
          0,
          300,
        ),
      }),
    ).toBe("Inserted");
    await userEvent.keyboard("{Control>}z{/Control}");
    await userEvent.keyboard("{Control>}z{/Control}");
    await settle();
    await userEvent.click(target(prose, 1, 1));
    await choose("Column Options", "Insert Right");
    expect(cells(prose)).toEqual([
      ["Step", "Owner", "", "Status"],
      ["Edit", "Web", "", "Ready"],
      ["Review", "QA", "", "Done"],
    ]);
  });

  it("inserts above/below, retains column alignment, and closes without edits", async () => {
    const prose = await mount(width);
    await userEvent.click(target(prose, 1, 1));
    await choose("Row Options", "Insert Above");
    expect(cells(prose)).toEqual([
      ["Step", "Owner", "Status"],
      ["", "", ""],
      ["Edit", "Web", "Ready"],
      ["Review", "QA", "Done"],
    ]);
    expect(target(prose, 1, 1).style.textAlign).toBe("center");
    await userEvent.keyboard("{Control>}z{/Control}");
    await settle();
    await userEvent.click(target(prose, 1, 1));
    await choose("Row Options", "Insert Below");
    expect(cells(prose)[2]).toEqual(["", "", ""]);
    await userEvent.click(button("Column Options"));
    await userEvent.keyboard("{Escape}");
    await settle();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    const rect = button("Column Options").getBoundingClientRect();
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.right).toBeLessThanOrEqual(width);
    expect(
      button("Add Column").getBoundingClientRect().right,
    ).toBeLessThanOrEqual(width);
    const after = [...prose.querySelectorAll("p")].find(
      (p) => p.textContent === "After.",
    );
    expect(
      button("Add Row").getBoundingClientRect().bottom,
    ).toBeLessThanOrEqual(after?.getBoundingClientRect().top ?? 0);
    await userEvent.click(prose.querySelector("p") as HTMLElement);
    await settle();
    expect(tools()).toBeNull();
  });

  it("keeps exactly one GFM header when inserting above or deleting the first row", async () => {
    const prose = await mount(width);
    await userEvent.click(target(prose, 0, 1));
    await choose("Row Options", "Insert Above");
    expect(cells(prose)[1]).toEqual(["Step", "Owner", "Status"]);
    expect(
      [...(target(prose, 0, 0).parentElement?.children ?? [])].map(
        (cell) => cell.tagName,
      ),
    ).toEqual(["TH", "TH", "TH"]);
    expect(
      [...(target(prose, 1, 0).parentElement?.children ?? [])].map(
        (cell) => cell.tagName,
      ),
    ).toEqual(["TD", "TD", "TD"]);
    expect(target(prose, 0, 1).style.textAlign).toBe("center");
    await choose("Row Options", "Delete Row");
    expect(cells(prose)[0]).toEqual(["Step", "Owner", "Status"]);
    expect(
      [...(target(prose, 0, 0).parentElement?.children ?? [])].map(
        (cell) => cell.tagName,
      ),
    ).toEqual(["TH", "TH", "TH"]);
  });

  it.each([
    ["Column Options", "Insert Left"],
    ["Column Options", "Insert Right"],
    ["Row Options", "Insert Above"],
    ["Row Options", "Insert Below"],
  ])("round trips %s / %s through saved GFM", async (menu, action) => {
    const prose = await mount(width);
    await userEvent.click(target(prose, 1, 1));
    await choose(menu, action);
    await userEvent.keyboard("Inserted");
    const expected = cells(prose);
    expect(expected.flat()).toContain("Inserted");
    await userEvent.keyboard("{Control>}s{/Control}");
    await expect.poll(saved).toContain("Inserted");
    // The editor took the save, so nothing retries it into a later test.
    await expect
      .poll(() => document.querySelector(".artifact-save")?.textContent)
      .toBe("Saved");
    const source = saved();
    await React.act(() => root?.unmount());
    root = undefined;
    document.body.replaceChildren();
    const reloaded = await mount(width, false, source);
    expect(cells(reloaded)).toEqual(expected);
    expect(target(reloaded, 0, 0).tagName).toBe("TH");
  });

  it("adds/deletes only the targeted row/column and retains the other table", async () => {
    const prose = await mount(width, false, `${markdown}\n${markdown}`);
    await userEvent.click(target(prose, 1, 1));
    await userEvent.click(button("Add Column"));
    await settle();
    expect(cells(prose)[1]).toHaveLength(4);
    await choose("Column Options", "Delete Column");
    expect(cells(prose)[1]).toEqual(["Edit", "Web", "Ready"]);
    await userEvent.click(button("Add Row"));
    await settle();
    expect(cells(prose)).toHaveLength(4);
    await choose("Row Options", "Delete Row");
    expect(cells(prose)).toHaveLength(3);
    expect(prose.querySelectorAll("table")[1]?.textContent).toBe(
      "StepOwnerStatusEditWebReadyReviewQADone",
    );
  });

  it("keeps native context behavior outside a table and hides mutations for readers", async () => {
    const prose = await mount(width, true);
    await rightClick(target(prose, 1, 1));
    expect(tools()).toBeNull();
    await rightClick(prose.querySelector("p") as HTMLElement);
    expect(tools()).toBeNull();
  });
});
