/**
 * Links in an artifact open in a new tab on a click, a Cmd or Ctrl click,
 * and a phone tap, in a table cell as anywhere else (#1724, the owner's
 * report).
 *
 * Ways it can fail, each covered below:
 *  1. A link in a table cell does not open, on a click, a Cmd or Ctrl click,
 *     or a tap, while one in a paragraph does, or neither opens.
 *  2. A link opens where the person is editing instead: on a drag that
 *     selects text, or a Shift click that extends the selection.
 *  3. In a cell with both a link and a comment, the link opens the comment
 *     (or both), or the commented text stops opening the comment.
 *  4. A link opens without noopener, or an unsafe href opens at all.
 *  5. A reader's view (no editing) does not open links, or opens one twice.
 *  6. A URL in a comment is plain text, not a link that opens in a new tab.
 */
import type { ThreadArtifact, ThreadArtifactComment } from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import { QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { AuthContext } from "../../../shared/auth/auth-context.js";
import { createQueryClient } from "../../../shared/query/query-client.js";
import { artifactCommentsOptions } from "../artifact-comments-queries.js";
import { ArtifactEditor } from "./artifact-editor.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const threadId = "thr_00000000-0000-4000-8000-0000000000f2" as ThreadId;
const userId = "usr_links" as UserId;

const artifact = (): ThreadArtifact => ({
  id: `art_${"e".repeat(32)}`,
  threadId,
  kind: "document",
  folder: "",
  title: "Links",
  revision: 1,
  sizeBytes: 0,
  createdBy: { kind: "agent" },
  updatedBy: { kind: "agent" },
  openCommentCount: 0,
  createdAt: 0,
  updatedAt: 0,
});

let root: Root | undefined;
let opened: Array<ReadonlyArray<unknown>> = [];
afterEach(async () => {
  await React.act(() => root?.unmount());
  root = undefined;
  opened = [];
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const mount = async (
  markdown: string,
  comments: ReadonlyArray<ThreadArtifactComment> = [],
  readOnly = false,
) => {
  vi.stubGlobal("fetch", () => new Promise<Response>(() => {}));
  vi.spyOn(window, "open").mockImplementation((...args) => {
    opened.push(args);
    return null;
  });
  const container = document.body.appendChild(document.createElement("div"));
  container.style.height = "700px";
  container.style.width = "800px";
  container.style.display = "flex";
  const client = createQueryClient();
  client.setQueryData(
    artifactCommentsOptions(threadId, artifact().id).queryKey,
    comments,
  );
  root = createRoot(container);
  await React.act(() =>
    root?.render(
      <QueryClientProvider client={client}>
        <AuthContext
          value={{
            identity: { id: userId, name: "Test", email: "t@dx.test" },
            logout: () => undefined,
          }}
        >
          <ArtifactEditor
            threadId={threadId}
            initial={{ artifact: artifact(), markdown }}
            readOnly={readOnly}
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

const MARKDOWN = [
  "Read [the outside guide](https://example.com/outside) first.",
  "",
  "| Doc | Notes |",
  "| --- | --- |",
  "| [the cell guide](https://example.com/cell) | see the note here |",
  "| [unsafe](javascript:alert(1)) | plain |",
  "",
].join("\n");

const link = (prose: HTMLElement, text: string) => {
  const anchor = [...prose.querySelectorAll<HTMLElement>("a")].find(
    (element) => element.textContent === text,
  );
  if (anchor === undefined) throw new Error(`No link ${text}`);
  return anchor;
};

const openedUrls = () => opened.map(([url]) => url);

/** A phone tap: Chrome's click after a touch carries pointerType "touch". */
const tap = async (element: HTMLElement) => {
  const box = element.getBoundingClientRect();
  const at = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: box.left + 4,
    clientY: box.top + box.height / 2,
    pointerType: "touch",
    isPrimary: true,
  };
  element.dispatchEvent(new PointerEvent("pointerdown", at));
  element.dispatchEvent(new PointerEvent("pointerup", at));
  element.dispatchEvent(new PointerEvent("click", { ...at, button: 0 }));
  await settle();
};

const comment = (
  id: string,
  text: string,
  at: number,
  body = `About ${text}`,
): ThreadArtifactComment => ({
  id: `cmt_${id.repeat(32)}`,
  artifactId: artifact().id,
  parentId: null,
  quote: text,
  target: null,
  anchor: { revision: 1, start: at, end: at + text.length },
  author: { kind: "agent" },
  body,
  createdAt: 1,
  resolvedAt: null,
});

describe("links in an artifact", () => {
  it("open in a new tab on a click, in a table cell as in a paragraph", async () => {
    const { prose } = await mount(MARKDOWN);
    await userEvent.click(link(prose, "the outside guide"));
    await settle();
    await userEvent.click(link(prose, "the cell guide"));
    await settle();
    expect(opened).toEqual([
      ["https://example.com/outside", "_blank", "noopener,noreferrer"],
      ["https://example.com/cell", "_blank", "noopener,noreferrer"],
    ]);
  });

  it("open on a Cmd or Ctrl click in a table cell", async () => {
    const { prose } = await mount(MARKDOWN);
    for (const key of ["Meta", "Control"]) {
      await userEvent.keyboard(`{${key}>}`);
      await userEvent.click(link(prose, "the cell guide"));
      await userEvent.keyboard(`{/${key}}`);
      await settle();
    }
    expect(openedUrls()).toEqual([
      "https://example.com/cell",
      "https://example.com/cell",
    ]);
  });

  it("open on a phone tap in a table cell", async () => {
    const { prose } = await mount(MARKDOWN);
    await tap(link(prose, "the cell guide"));
    await tap(link(prose, "the outside guide"));
    expect(openedUrls()).toEqual([
      "https://example.com/cell",
      "https://example.com/outside",
    ]);
  });

  it("stay closed while the person selects text or extends a selection, and never open an unsafe href", async () => {
    const { prose } = await mount(MARKDOWN);
    const cell = link(prose, "the cell guide");
    const box = cell.getBoundingClientRect();
    // A drag across the link ends with the link text selected, and the
    // click that ends it lands on the link.
    prose.focus();
    const range = document.createRange();
    range.selectNodeContents(cell);
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);
    await settle();
    cell.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: box.right - 2,
        clientY: box.top + 4,
      }),
    );
    await settle();
    await userEvent.keyboard("{Shift>}");
    await userEvent.click(link(prose, "the outside guide"));
    await userEvent.keyboard("{/Shift}");
    await settle();
    // The unsafe link is no link at all.
    const unsafe = [...prose.querySelectorAll<HTMLElement>("td")].find((td) =>
      td.textContent?.includes("unsafe"),
    );
    if (unsafe === undefined) throw new Error("No unsafe cell.");
    expect(unsafe.querySelector("a[href]")).toBeNull();
    await userEvent.click(unsafe);
    await settle();
    expect(opened).toEqual([]);
  });

  it("open the link from a cell that also has a comment, and the comment from its text", async () => {
    const markdown = MARKDOWN;
    const quote = "see the note here";
    const start = markdown.indexOf(quote);
    const linked = "the cell guide";
    const linkedStart = markdown.indexOf(linked);
    const { prose } = await mount(markdown, [
      comment("1", quote, start),
      comment("2", linked, linkedStart),
    ]);
    await settle(200);
    // The link, itself commented, opens the link and not the comment.
    await userEvent.click(link(prose, linked));
    await settle();
    expect(openedUrls()).toEqual(["https://example.com/cell"]);
    expect(
      document.querySelector('[role="dialog"][aria-label="Comment"]'),
    ).toBeNull();
    // The commented text beside it opens its comment.
    const note = [...prose.querySelectorAll<HTMLElement>("td span")].find(
      (span) => span.textContent === quote,
    );
    if (note === undefined) throw new Error("No commented text.");
    await userEvent.click(note);
    await settle(200);
    expect(
      document.querySelector('[role="dialog"][aria-label="Comment"]')
        ?.textContent,
    ).toContain(`About ${quote}`);
    expect(openedUrls()).toEqual(["https://example.com/cell"]);
  });

  it("open once from a reader's view, which cannot edit", async () => {
    const { prose } = await mount(MARKDOWN, [], true);
    await userEvent.click(link(prose, "the cell guide"));
    await settle();
    await userEvent.click(link(prose, "the outside guide"));
    await settle();
    expect(openedUrls()).toEqual([
      "https://example.com/cell",
      "https://example.com/outside",
    ]);
  });

  it("make a URL in a comment a link that opens in a new tab", async () => {
    const quote = "see the note here";
    const { prose } = await mount(MARKDOWN, [
      comment(
        "3",
        quote,
        MARKDOWN.indexOf(quote),
        "Spec at https://example.com/spec?a=1, and (https://example.com/two).",
      ),
    ]);
    await settle(200);
    const note = [...prose.querySelectorAll<HTMLElement>("td span")].find(
      (span) => span.textContent === quote,
    );
    if (note === undefined) throw new Error("No commented text.");
    await userEvent.click(note);
    await settle(200);
    const body = document.querySelector<HTMLElement>(".artifact-comment-body");
    expect(body?.textContent).toBe(
      "Spec at https://example.com/spec?a=1, and (https://example.com/two).",
    );
    const anchors = [...(body?.querySelectorAll("a") ?? [])].map((anchor) => [
      anchor.getAttribute("href"),
      anchor.textContent,
      anchor.getAttribute("target"),
      anchor.getAttribute("rel"),
    ]);
    expect(anchors).toEqual([
      [
        "https://example.com/spec?a=1",
        "https://example.com/spec?a=1",
        "_blank",
        "noopener noreferrer",
      ],
      [
        "https://example.com/two",
        "https://example.com/two",
        "_blank",
        "noopener noreferrer",
      ],
    ]);
  });
});
