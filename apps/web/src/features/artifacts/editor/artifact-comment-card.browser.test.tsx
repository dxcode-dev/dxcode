/**
 * Comments sit at their text (owner direction, 2026-11-06, matching the
 * reference editor): a card opens against the highlighted text, on a wide
 * pane and on a phone, instead of a column beside the artifact.
 *
 * Ways it can fail, each covered below:
 *  1. Clicking highlighted text opens a side column, or a card far from the
 *     text, or one wider than the pane (a phone).
 *  2. Commenting on a selection loses the selected text's highlight while
 *     writing, posts without its quote, needs a mouse to send (Enter must
 *     post, Shift+Enter must start a new line), or leaves the highlight
 *     behind after Escape.
 *  3. The card cannot be closed by clicking elsewhere or by Escape.
 *  4. Resolve is missing from the card, or does not call the API.
 *  5. The header's Comments button does not list the open comments, or
 *     choosing one does not open its card.
 *  7. What someone types right after sending is wiped when the post lands
 *     (seen on the branch preview, 2026-11-06).
 *  6. The `@` list is clipped by the card, or the selection's toolbar still
 *     shows over the card (seen on the branch preview, 2026-11-06).
 */
import type { ThreadArtifact, ThreadArtifactComment } from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import { QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { AuthContext } from "../../../shared/auth/auth-context.js";
import { createQueryClient } from "../../../shared/query/query-client.js";
import { artifactCommentsOptions } from "../artifact-comments-queries.js";
import { ArtifactEditor } from "./artifact-editor.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const threadId = "thr_00000000-0000-4000-8000-0000000000c7" as ThreadId;
const userId = "usr_olive" as UserId;
const artifact = (): ThreadArtifact => ({
  id: `art_${"7".repeat(32)}`,
  threadId,
  kind: "document",
  folder: "",
  title: "Card",
  revision: 1,
  sizeBytes: 0,
  createdBy: { kind: "agent" },
  updatedBy: { kind: "agent" },
  openCommentCount: 0,
  createdAt: 0,
  updatedAt: 0,
});
const MARKDOWN =
  "Ship it today.\n\nThe second paragraph has more words in it.\n\nA third line.\n";
const QUOTE = "Ship it";
const ROOT = `cmt_${"1".repeat(32)}`;
const seeded: ThreadArtifactComment = {
  id: ROOT,
  artifactId: artifact().id,
  parentId: null,
  quote: QUOTE,
  target: null,
  anchor: { revision: 1, start: 0, end: QUOTE.length },
  author: { kind: "user", userId: "usr_maya", name: "Maya Member" },
  body: "Is today right?",
  createdAt: 1,
  resolvedAt: null,
};

let root: Root | undefined;
let calls: Array<{ method: string; url: string; body: unknown }> = [];
/** Answers the next POST, when a test holds it. */
let answer: ((response: Response) => void) | undefined;
afterEach(async () => {
  await React.act(() => root?.unmount());
  root = undefined;
  calls = [];
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const mount = async (width: number, comments = [seeded]) => {
  await page.viewport(width, 800);
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    if (method !== "GET")
      calls.push({
        method,
        url,
        body:
          init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
    return new Promise<Response>(() => {});
  });
  const container = document.body.appendChild(document.createElement("div"));
  container.style.cssText = `height:760px;width:${width}px;display:flex`;
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
            identity: { id: userId, name: "Olive Owner", email: "o@dx.test" },
            logout: () => undefined,
          }}
        >
          <ArtifactEditor
            threadId={threadId}
            initial={{ artifact: artifact(), markdown: MARKDOWN }}
            readOnly={false}
            switcher={null}
          />
        </AuthContext>
      </QueryClientProvider>,
    ),
  );
  await settle(200);
  const prose = container.querySelector<HTMLElement>(".artifact-prose");
  if (prose === null) throw new Error("Expected the editor.");
  return { container, prose };
};

const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));
const card = () =>
  document.querySelector<HTMLElement>('[role="dialog"][aria-label="Comment"]');
const highlight = (prose: HTMLElement, id = ROOT) =>
  prose.querySelector<HTMLElement>(`[data-comment="${id}"]`);

const select = async (prose: HTMLElement, text: string) => {
  const walker = document.createTreeWalker(prose, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node !== null && !node.textContent?.includes(text))
    node = walker.nextNode();
  if (node === null) throw new Error(`No text ${text}`);
  const start = node.textContent?.indexOf(text) ?? 0;
  prose.focus();
  getSelection()?.setBaseAndExtent(node, start, node, start + text.length);
  await settle(150);
};

for (const width of [1440, 390]) {
  describe(`comment cards at ${width}`, () => {
    it("open at the highlighted text, inside the pane, with no side column", async () => {
      const { container, prose } = await mount(width);
      const text = highlight(prose);
      if (text === null) throw new Error("No highlight.");
      await userEvent.click(text);
      await settle(250);
      const open = card();
      expect(open).not.toBeNull();
      expect(open?.textContent).toContain("Maya Member");
      expect(open?.textContent).toContain("Is today right?");
      expect(container.querySelector(".artifact-comments")).toBeNull();
      const at = text.getBoundingClientRect();
      const box = open?.getBoundingClientRect();
      if (box === undefined) throw new Error("No card box.");
      // Right under (or over) the text, not across the page.
      const gap = Math.min(
        Math.abs(box.top - at.bottom),
        Math.abs(at.top - box.bottom),
      );
      expect(gap).toBeLessThan(24);
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(width);
      expect(
        open
          ?.querySelector('textarea[aria-label="Reply"]')
          ?.getAttribute("placeholder"),
      ).toBe("Reply, or @mention dx");
    });

    it("write a new comment on the selection, keeping it highlighted, and post it with Enter", async () => {
      const { prose } = await mount(width, []);
      await select(prose, "second paragraph");
      await userEvent.click(
        page.getByRole("button", { name: "Comment", exact: true }).last(),
      );
      await settle(300);
      const open = card();
      expect(open).not.toBeNull();
      expect(highlight(prose, "draft")?.textContent).toBe("second paragraph");
      const box = open?.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Comment"]',
      );
      if (box === null || box === undefined) throw new Error("No box.");
      expect(box.placeholder).toBe("Comment, or @mention dx");
      expect(document.activeElement).toBe(box);
      await userEvent.keyboard("Looks long{Shift>}{Enter}{/Shift}Trim it");
      expect(box.value).toBe("Looks long\nTrim it");
      await userEvent.keyboard("{Enter}");
      await settle();
      expect(calls).toEqual([
        expect.objectContaining({
          method: "POST",
          body: expect.objectContaining({
            quote: "second paragraph",
            body: "Looks long\nTrim it",
          }),
        }),
      ]);
    });

    it("close with Escape and with a click elsewhere, dropping an unsent draft's highlight", async () => {
      const { prose } = await mount(width);
      await select(prose, "third");
      await userEvent.click(
        page.getByRole("button", { name: "Comment", exact: true }).last(),
      );
      await settle(300);
      expect(card()).not.toBeNull();
      await userEvent.keyboard("{Escape}");
      await settle(200);
      expect(card()).toBeNull();
      expect(highlight(prose, "draft")).toBeNull();
      // Back in the text, its selection is done with: no toolbar returns.
      prose.focus();
      await settle(200);
      expect(document.querySelector(".artifact-selection-toolbar")).toBeNull();
      const text = highlight(prose);
      if (text === null) throw new Error("No highlight.");
      await userEvent.click(text);
      await settle(250);
      expect(card()).not.toBeNull();
      const other = document.querySelector<HTMLElement>(".artifact-header");
      if (other === null) throw new Error("No header.");
      await userEvent.click(other, { position: { x: 4, y: 4 } });
      await settle(250);
      expect(card()).toBeNull();
    });

    it("show the @ list whole, over the card, and no selection toolbar", async () => {
      const { prose } = await mount(width, []);
      await select(prose, "second paragraph");
      await userEvent.click(
        page.getByRole("button", { name: "Comment", exact: true }).last(),
      );
      await settle(300);
      expect(document.querySelector(".artifact-selection-toolbar")).toBeNull();
      await userEvent.keyboard("@");
      await settle(200);
      const list = document.querySelector<HTMLElement>(
        '[role="listbox"][aria-label="Mention someone"]',
      );
      if (list === null) throw new Error("No @ list.");
      const box = list.getBoundingClientRect();
      expect(box.height).toBeGreaterThan(20);
      const hit = document.elementFromPoint(
        box.left + box.width / 2,
        box.top + Math.min(box.height / 2, 14),
      );
      expect(list.contains(hit)).toBe(true);
    });

    it("keep what is typed after sending a reply, once the reply lands", async () => {
      const { prose } = await mount(width);
      const text = highlight(prose);
      if (text === null) throw new Error("No highlight.");
      await userEvent.click(text);
      await settle(250);
      const box = card()?.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Reply"]',
      );
      if (box === null || box === undefined) throw new Error("No box.");
      await userEvent.click(box);
      await userEvent.keyboard("Yes{Enter}");
      await settle();
      expect(box.value).toBe("");
      await userEvent.keyboard("And Monday");
      answer?.(
        Response.json({
          status: "success",
          data: {
            comment: {
              ...seeded,
              id: `cmt_${"2".repeat(32)}`,
              parentId: ROOT,
              quote: "",
              anchor: null,
              body: "Yes",
            },
          },
        }),
      );
      await settle(300);
      expect(box.value).toBe("And Monday");
    });

    it("resolve from the card", async () => {
      const { prose } = await mount(width);
      const text = highlight(prose);
      if (text === null) throw new Error("No highlight.");
      await userEvent.click(text);
      await settle(250);
      const resolve = card()?.querySelector<HTMLElement>(
        '[aria-label="Resolve"]',
      );
      if (resolve === null || resolve === undefined)
        throw new Error("No Resolve.");
      await userEvent.click(resolve);
      await settle();
      expect(calls).toEqual([
        expect.objectContaining({
          method: "POST",
          url: expect.stringContaining(`/comments/${ROOT}/resolve`),
        }),
      ]);
    });

    it("list the open comments from the header and open the chosen one", async () => {
      await mount(width);
      await userEvent.click(
        page.getByRole("button", { name: "Comments (1)", exact: true }),
      );
      await settle(200);
      const item = page.getByRole("menuitem", { name: /Is today right\?/ });
      await expect.element(item).toBeVisible();
      await userEvent.click(item);
      await settle(400);
      expect(card()?.textContent).toContain("Is today right?");
    });
  });
}
