/**
 * The toolbar at an artifact selection (#1805, the owner's ask): Bold,
 * Italic, Strikethrough, Code, Link, Comment, Copy as Markdown, and Send to
 * Thread, floating at the selected text.
 *
 * Ways it can fail, each covered below:
 *  1. It shows with nothing selected, or does not show for a selection.
 *  2. It sits away from the selection, or off the edge of the page.
 *  3. A button does nothing to the selection, or loses it, so a second
 *     button acts on nothing; or its pressed state lies.
 *  4. Its tooltips leave out the keys that do the same.
 *  5. Link makes an unsafe link, or cannot remove one; Ctrl/Cmd+K does
 *     not open it.
 *  6. Copy as Markdown copies plain text, losing the formatting.
 *  7. Send to Thread replaces what the person was writing to the agent, or
 *     sends nothing.
 *  8. On a touch screen it covers the native selection menu with buttons
 *     the native menu already has, instead of the one it lacks: Comment.
 *  9. It shows to someone who can only read the artifact.
 */
import type { ThreadArtifact } from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import { QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";
import "../../../styles.css";
import "../artifacts-view.css";
import { AuthContext } from "../../../shared/auth/auth-context.js";
import { createQueryClient } from "../../../shared/query/query-client.js";
import { threadDraftKeys } from "../../threads/thread-draft-queries.js";
import { ArtifactEditor } from "./artifact-editor.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const threadId = "thr_00000000-0000-4000-8000-0000000000d5" as ThreadId;
const userId = "usr_selection" as UserId;

const artifact = (): ThreadArtifact => ({
  id: `art_${"d".repeat(32)}`,
  threadId,
  folder: "",
  title: "Launch notes",
  revision: 1,
  sizeBytes: 0,
  createdBy: { kind: "agent" },
  updatedBy: { kind: "agent" },
  openCommentCount: 0,
  createdAt: 0,
  updatedAt: 0,
});

const MARKDOWN = [
  "Ship the beta on Friday after the review.",
  "",
  "A second paragraph that runs long enough to reach the right edge of the page on a desktop screen, ending here.",
  "",
].join("\n");

let root: Root | undefined;
afterEach(async () => {
  await React.act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: false });
  await cdp().send("Emulation.setEmitTouchEventsForMouse", { enabled: false });
  await page.viewport(1280, 800);
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 80));

const mount = async (
  options: { readOnly?: boolean; width?: number; draft?: string } = {},
) => {
  await page.viewport(options.width ?? 1440, 900);
  document.body.style.margin = "0";
  vi.stubGlobal("fetch", () => new Promise<Response>(() => {}));
  const client = createQueryClient();
  if (options.draft !== undefined)
    client.setQueryData(threadDraftKeys.draft(userId, threadId), options.draft);
  const container = document.body.appendChild(document.createElement("div"));
  container.style.height = "900px";
  container.style.display = "flex";
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
            initial={{ artifact: artifact(), markdown: MARKDOWN }}
            readOnly={options.readOnly ?? false}
            switcher={null}
          />
        </AuthContext>
      </QueryClientProvider>,
    ),
  );
  const prose = container.querySelector<HTMLElement>(".artifact-prose");
  if (prose === null) throw new Error("Expected the editor.");
  return { container, prose, client };
};

/** Selects `text` in the text node that holds it, as a drag would. */
const select = async (prose: HTMLElement, text: string) => {
  const walker = document.createTreeWalker(prose, NodeFilter.SHOW_TEXT);
  let node: Text | undefined;
  for (let next = walker.nextNode(); next !== null; next = walker.nextNode())
    if ((next as Text).data.includes(text)) {
      node = next as Text;
      break;
    }
  if (node === undefined) throw new Error(`No text node for ${text}`);
  const start = node.data.indexOf(text);
  prose.focus();
  getSelection()?.setBaseAndExtent(node, start, node, start + text.length);
  document.dispatchEvent(new Event("selectionchange"));
  await settle();
  await settle();
};

const toolbar = () =>
  document.querySelector<HTMLElement>(
    '[role="toolbar"][aria-label="Selection"]',
  );

const button = (name: string) => {
  const found = toolbar()?.querySelector<HTMLButtonElement>(
    `button[aria-label="${name}"]`,
  );
  if (found === null || found === undefined) throw new Error(`No ${name}`);
  return found;
};

const NAMES = [
  "Bold",
  "Italic",
  "Strikethrough",
  "Code",
  "Link",
  "Comment",
  "Copy as Markdown",
  "Send to Thread",
];

describe("the selection toolbar on a desktop", () => {
  it("shows only for selected text, at the selection, with every action and its keys", async () => {
    const { prose } = await mount();
    prose.focus();
    await settle();
    expect(toolbar()).toBeNull();
    await select(prose, "beta on Friday");
    const bar = toolbar();
    expect(bar).not.toBeNull();
    expect(
      [...(bar?.querySelectorAll("button") ?? [])].map((b) =>
        b.getAttribute("aria-label"),
      ),
    ).toEqual(NAMES);
    // Shortcuts in the tooltips, as the reference has them.
    const mod = /Mac/.test(navigator.platform) ? "⌘" : "Ctrl+";
    expect(button("Bold").title).toBe(`Bold (${mod}B)`);
    expect(button("Italic").title).toBe(`Italic (${mod}I)`);
    expect(button("Strikethrough").title).toBe(`Strikethrough (${mod}Shift+X)`);
    expect(button("Code").title).toBe(`Code (${mod}E)`);
    expect(button("Link").title).toBe(`Link (${mod}K)`);
    // Just above the selection, within the page.
    const range = getSelection()?.getRangeAt(0).getBoundingClientRect();
    const box = bar?.getBoundingClientRect();
    if (range === undefined || box === undefined) throw new Error("No boxes");
    expect(box.bottom).toBeLessThanOrEqual(range.top + 1);
    expect(range.top - box.bottom).toBeLessThan(24);
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(window.innerWidth);
    // Collapsing the selection hides it.
    const node = prose.querySelector("p")?.firstChild as Text;
    getSelection()?.setBaseAndExtent(node, 2, node, 2);
    document.dispatchEvent(new Event("selectionchange"));
    await settle();
    expect(toolbar()).toBeNull();
  });

  it("formats the selection and keeps it, so the next button acts on it too", async () => {
    const { prose } = await mount();
    await select(prose, "beta on Friday");
    await userEvent.click(button("Bold"));
    await settle();
    expect(prose.querySelector("strong")?.textContent).toBe("beta on Friday");
    expect(button("Bold").getAttribute("aria-pressed")).toBe("true");
    await userEvent.click(button("Italic"));
    await settle();
    expect(prose.querySelector("em")?.textContent).toBe("beta on Friday");
    await userEvent.click(button("Bold"));
    await settle();
    expect(prose.querySelector("strong")).toBeNull();
    expect(button("Bold").getAttribute("aria-pressed")).toBe("false");
    await userEvent.click(button("Strikethrough"));
    await userEvent.click(button("Code"));
    await settle();
    expect(prose.querySelector("s, del")?.textContent).toBe("beta on Friday");
    expect(prose.querySelector("code")?.textContent).toBe("beta on Friday");
  });

  it("links the selection, refuses an unsafe link, removes one, and opens with Ctrl/Cmd+K", async () => {
    const { prose } = await mount();
    await select(prose, "the review");
    await userEvent.click(button("Link"));
    const field = toolbar()?.querySelector<HTMLInputElement>(
      'input[aria-label="Link"]',
    );
    expect(field).not.toBeNull();
    await userEvent.type(
      field as HTMLInputElement,
      "javascript:alert(1){Enter}",
    );
    await settle();
    expect(prose.querySelector("a")).toBeNull();
    expect(toolbar()?.textContent).toContain("web or mail link");
    await userEvent.clear(field as HTMLInputElement);
    await userEvent.type(
      field as HTMLInputElement,
      "https://example.com/review{Enter}",
    );
    await settle();
    expect(prose.querySelector("a")?.getAttribute("href")).toBe(
      "https://example.com/review",
    );
    expect(prose.querySelector("a")?.textContent).toBe("the review");
    // Ctrl/Cmd+K on the linked selection opens the field with its link;
    // emptying it removes the link.
    await select(prose, "the review");
    await userEvent.keyboard("{Control>}k{/Control}");
    await settle();
    const again = toolbar()?.querySelector<HTMLInputElement>(
      'input[aria-label="Link"]',
    );
    expect(again?.value).toBe("https://example.com/review");
    await userEvent.clear(again as HTMLInputElement);
    await userEvent.keyboard("{Enter}");
    await settle();
    expect(prose.querySelector("a")).toBeNull();
  });

  it("copies the selection as Markdown, with its formatting", async () => {
    const written: string[] = [];
    vi.stubGlobal("navigator", {
      ...navigator,
      platform: navigator.platform,
      clipboard: {
        writeText: async (text: string) => {
          written.push(text);
        },
      },
    });
    const { prose } = await mount();
    await select(prose, "beta on Friday");
    await userEvent.click(button("Bold"));
    await userEvent.click(button("Copy as Markdown"));
    await settle();
    expect(written).toEqual(["**beta on Friday**"]);
    expect(toolbar()?.textContent).toContain("Copied");
  });

  it("sends the selection to the Thread as a quote after what the person was writing", async () => {
    const { prose, client } = await mount({ draft: "My question:" });
    const composer = document.body.appendChild(
      document.createElement("textarea"),
    );
    composer.dataset.commandTarget = "thread-composer";
    await select(prose, "beta on Friday");
    await userEvent.click(button("Send to Thread"));
    await settle();
    expect(client.getQueryData(threadDraftKeys.draft(userId, threadId))).toBe(
      "My question:\n\n> beta on Friday\n\n",
    );
    expect(document.activeElement).toBe(composer);
  });

  it("stays inside the page for a selection at its right edge", async () => {
    const { prose } = await mount({ width: 900 });
    await select(prose, "ending here.");
    const box = toolbar()?.getBoundingClientRect();
    if (box === undefined) throw new Error("No toolbar");
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(window.innerWidth);
  });

  it("hides once focus leaves the editor, and shows again on return", async () => {
    // Seen on the branch preview: a selection kept its toolbar over Find,
    // the comments list, and a dropdown's picker.
    const { prose } = await mount();
    await select(prose, "beta");
    expect(toolbar()).not.toBeNull();
    await userEvent.click(
      page.getByRole("button", { name: "Find in Artifact", exact: true }),
    );
    await settle();
    expect(toolbar()).toBeNull();
    await select(prose, "beta");
    expect(toolbar()).not.toBeNull();
  });

  it("does not show to someone who can only read", async () => {
    const { prose } = await mount({ readOnly: true });
    await select(prose, "beta on Friday");
    expect(toolbar()).toBeNull();
  });
});

describe("the selection toolbar on a touch screen", () => {
  it("adds only Comment, below the selection, clear of the native menu", async () => {
    await cdp().send("Emulation.setTouchEmulationEnabled", {
      enabled: true,
      maxTouchPoints: 5,
    });
    const { prose } = await mount({ width: 390 });
    await select(prose, "beta on Friday");
    const bar = toolbar();
    expect(
      [...(bar?.querySelectorAll("button") ?? [])].map((b) =>
        b.getAttribute("aria-label"),
      ),
    ).toEqual(["Comment"]);
    const range = getSelection()?.getRangeAt(0).getBoundingClientRect();
    const box = bar?.getBoundingClientRect();
    if (range === undefined || box === undefined) throw new Error("No boxes");
    expect(box.top).toBeGreaterThanOrEqual(range.bottom - 1);
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(window.innerWidth);
  });
});
