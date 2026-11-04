/**
 * The `/` block menu and the `@` people picker in the artifact editor
 * (#1651, the owner's request), with real key presses and clicks.
 *
 * Ways it can fail, each covered below:
 *  1. `/` or `@` opens nothing, or opens in the middle of a word or a URL.
 *  2. Typing does not filter, or filters out what was asked for.
 *  3. Arrows, Enter, or Tab do not pick, or Enter also splits the block.
 *  4. Escape drops the typed `/` or `@`, or the menu reopens at once.
 *  5. A picked block or chip lands in the wrong place or leaves the `/query`
 *     behind.
 *  6. A tap or click on an option does nothing (a phone has no arrows).
 *  7. `@` lists people who cannot open the Thread, the viewer, or not dx.
 *  8. A row is cut short, so the highlight ends above its text (#1651).
 *  9. Rows lack the icon, group heading, or Markdown shortcut that dx's other
 *     menus show; people lack an avatar or their @username.
 * 10. The active row scrolls out of sight, the menu runs off the bottom of
 *     the editor instead of opening above the caret, or past a phone's edge.
 */
import type { ThreadArtifact, ThreadMemberData } from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import { QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { AuthContext } from "../../../shared/auth/auth-context.js";
import { createQueryClient } from "../../../shared/query/query-client.js";
import { threadKeys } from "../../threads/thread-queries.js";
import { ArtifactEditor } from "./artifact-editor.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const threadId = "thr_00000000-0000-4000-8000-0000000000c1" as ThreadId;
const userId = "usr_viewer" as UserId;

const member = (id: string, name: string, handle: string): ThreadMemberData =>
  ({
    userId: id as UserId,
    name,
    handle,
    email: `${handle}@dx.test`,
  }) as ThreadMemberData;

const MEMBERS = [
  member("usr_viewer", "Viewer Self", "viewer"),
  member("usr_ada", "Ada Lovelace", "ada"),
  member("usr_grace", "Grace Hopper", "grace"),
];

const artifact = (): ThreadArtifact => ({
  id: `art_${"c".repeat(32)}`,
  threadId,
  folder: "",
  title: "Suggest",
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

const mount = async (markdown: string, width?: number) => {
  vi.stubGlobal("fetch", () => new Promise<Response>(() => {}));
  const client = createQueryClient();
  client.setQueryData(threadKeys.members(userId, threadId), MEMBERS);
  const container = document.body.appendChild(document.createElement("div"));
  container.style.height = "800px";
  container.style.display = "flex";
  if (width !== undefined) container.style.width = `${width}px`;
  root = createRoot(container);
  await React.act(() =>
    root?.render(
      <QueryClientProvider client={client}>
        <AuthContext
          value={{
            identity: { id: userId, name: "Viewer Self", email: "v@dx.test" },
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
  await userEvent.click(prose);
  return { container, prose };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 40));
const type = async (text: string) => {
  await userEvent.keyboard(text);
  await settle();
};
const menu = () => document.querySelector<HTMLElement>(".artifact-suggest");
/** Each option's label. */
const options = () =>
  [
    ...document.querySelectorAll<HTMLElement>(
      ".artifact-suggest [role=option] .artifact-suggest-label",
    ),
  ].map((label) => label.textContent ?? "");
const active = () =>
  document.querySelector<HTMLElement>(
    ".artifact-suggest [role=option][aria-selected=true]",
  )?.textContent ?? "";

describe("the / block menu", () => {
  it("opens at the start of a block, filters as you type, and Enter makes the block", async () => {
    const { prose } = await mount("");
    await type("/");
    expect(menu()).not.toBeNull();
    expect(options()).toEqual(
      expect.arrayContaining([
        "Heading 1",
        "Checklist",
        "Table",
        "Code",
        "Quote",
        "Divider",
        "View",
        "Date",
        "Dropdown",
      ]),
    );
    await type("tab");
    expect(active()).toContain("Table");
    await type("{Enter}");
    expect(menu()).toBeNull();
    expect(prose.querySelectorAll("table").length).toBe(1);
    expect(prose.textContent).not.toContain("/tab");
    await type("Cell");
    expect(prose.querySelector("th")?.textContent).toBe("Cell");
  });

  it("turns the block into a heading, and the text typed next goes into it", async () => {
    const { prose } = await mount("");
    await type("/h2{Enter}Plan");
    expect(prose.querySelector("h2")?.textContent).toBe("Plan");
  });

  it("moves with the arrows and picks with Tab", async () => {
    const { prose } = await mount("");
    await type("/head");
    const first = active();
    await type("{ArrowDown}");
    expect(active()).not.toBe(first);
    await type("{ArrowUp}");
    expect(active()).toBe(first);
    await type("{ArrowDown}{Tab}");
    expect(prose.querySelector("h2")).not.toBeNull();
  });

  it("inserts a chip where the / was, after a space mid-line", async () => {
    const { prose } = await mount("Due\n");
    await type("{End} /date{Enter}");
    const chip = prose.querySelector<HTMLElement>(
      ".artifact-chip[data-kind=date]",
    );
    expect(chip).not.toBeNull();
    expect(prose.querySelector("p")?.textContent?.startsWith("Due ")).toBe(
      true,
    );
    expect(prose.textContent).not.toContain("/date");
  });

  it("stays shut inside a word or a link, and Escape keeps the typed /", async () => {
    const { prose } = await mount("");
    await type("and/or");
    expect(menu()).toBeNull();
    await type(" /");
    expect(menu()).not.toBeNull();
    await type("{Escape}");
    expect(menu()).toBeNull();
    await type("x");
    expect(menu()).toBeNull();
    expect(prose.textContent).toBe("and/or /x");
  });

  it("picks an option with a click or tap", async () => {
    const { prose } = await mount("");
    await type("/");
    const quote = [
      ...document.querySelectorAll<HTMLElement>(
        ".artifact-suggest [role=option]",
      ),
    ].find((option) => option.textContent?.includes("Quote"));
    if (quote === undefined) throw new Error("No Quote option");
    await userEvent.click(quote);
    await settle();
    expect(prose.querySelector("blockquote")).not.toBeNull();
    expect(menu()).toBeNull();
  });
});

describe("the @ people picker", () => {
  it("lists dx and the Thread's people but not you, and filters by name", async () => {
    await mount("");
    await type("@");
    expect(options()).toEqual(["dx", "Ada Lovelace", "Grace Hopper"]);
    await type("gr");
    expect(options().length).toBe(1);
    expect(active()).toContain("Grace Hopper");
  });

  it("inserts a mention chip for a person or for dx", async () => {
    const { prose } = await mount("Owner:\n");
    await type("{End} @ada{Enter}and @dx{Enter}");
    const mentions = [
      ...prose.querySelectorAll<HTMLElement>(".artifact-chip"),
    ].map((chip) => chip.dataset.source);
    expect(mentions).toEqual(["@[Ada Lovelace](user:usr_ada)", "@[dx](agent)"]);
    expect(prose.textContent).not.toContain("@ada");
  });

  it("does not open in an email address", async () => {
    await mount("");
    await type("me@dx.test");
    expect(menu()).toBeNull();
  });
});

const box = (element: Element | null) => {
  if (element === null) throw new Error("Expected an element.");
  return element.getBoundingClientRect();
};
const rows = () => [
  ...document.querySelectorAll<HTMLElement>(".artifact-suggest [role=option]"),
];

describe("the menus' look (#1651)", () => {
  it("keeps every row whole, so the highlight covers its text", async () => {
    await mount("");
    await type("/");
    expect(rows().length).toBeGreaterThan(8);
    for (const row of rows()) {
      expect(row.scrollHeight).toBeLessThanOrEqual(row.clientHeight);
      expect(box(row).height).toBeGreaterThanOrEqual(28);
    }
    const active = document.querySelector(
      ".artifact-suggest [role=option][aria-selected=true]",
    );
    expect(active?.hasAttribute("data-highlighted")).toBe(true);
  });

  it("groups blocks under headings, with an icon and the Markdown shortcut", async () => {
    await mount("");
    await type("/");
    const headings = [
      ...document.querySelectorAll(".artifact-suggest [role=presentation]"),
    ].map((heading) => heading.textContent);
    expect(headings).toEqual([
      "Basic blocks",
      "Lists",
      "Media and views",
      "Chips",
    ]);
    for (const row of rows()) expect(row.querySelector("svg")).not.toBeNull();
    const shortcut = (label: string) =>
      rows()
        .find((row) => row.textContent?.startsWith(label))
        ?.querySelector(".shortcut-keycaps")?.textContent;
    expect(shortcut("Heading 1")).toBe("#");
    expect(shortcut("Heading 2")).toBe("##");
    expect(shortcut("Checklist")).toBe("[ ]");
    expect(shortcut("Numbered list")).toBe("1.");
    expect(shortcut("Code")).toBe("```");
  });

  it("keeps the active row in view as the arrows move past the end", async () => {
    await mount("");
    await type("/");
    const list = document.querySelector(".artifact-suggest");
    await type("{ArrowUp}");
    expect(active()).toContain("Toggle");
    const row = document.querySelector(
      ".artifact-suggest [role=option][aria-selected=true]",
    );
    expect(box(row).bottom).toBeLessThanOrEqual(box(list).bottom + 1);
    expect(box(row).top).toBeGreaterThanOrEqual(box(list).top - 1);
  });

  it("opens above the caret near the bottom, inside the editor", async () => {
    const { container, prose } = await mount(
      Array.from({ length: 40 }, (_, line) => `Line ${line}`).join("\n\n"),
    );
    const scroller = container.querySelector(".artifact-scroll");
    if (scroller === null) throw new Error("Expected the scroller.");
    // The last line, at the bottom of the editor.
    await userEvent.click(prose.lastElementChild as HTMLElement);
    await type("{End} /");
    const menu = document.querySelector(".artifact-suggest");
    const caret = box(prose.lastElementChild);
    expect(box(menu).bottom).toBeLessThanOrEqual(caret.top + 1);
    expect(box(menu).top).toBeGreaterThanOrEqual(box(scroller).top - 1);
  });

  it("fits a phone's width", async () => {
    const { container } = await mount("", 390);
    await type("/");
    const menu = box(document.querySelector(".artifact-suggest"));
    expect(menu.left).toBeGreaterThanOrEqual(box(container).left);
    expect(menu.right).toBeLessThanOrEqual(box(container).right);
  });

  it("shows each person's avatar, name, and @username, and dx with its mark", async () => {
    await mount("");
    await type("@");
    const [agent, ada] = rows();
    expect(agent?.querySelector(".composer-mention-agent svg")).not.toBeNull();
    expect(ada?.querySelector(".dx-avatar")?.textContent).toBe("AL");
    expect(ada?.textContent).toContain("Ada Lovelace");
    expect(ada?.textContent).toContain("@ada");
  });
});
