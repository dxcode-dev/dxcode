/**
 * An artifact opened from the Artifacts library (`/artifacts/<id>`) offers
 * only what reaches someone from there. A standalone artifact lives in a
 * home that never runs an agent, and the library page has no Thread
 * composer, so agent and Thread actions would go nowhere.
 *
 * Ways it can fail, each covered below:
 *  1. A standalone artifact shows Notify agent in its toolbar.
 *  2. Selected text offers Send to Thread on the library page, where no
 *     composer takes the quote.
 *  3. A comment box offers Ask @dx, or its `@` list offers dx, on a
 *     standalone artifact.
 *  4. The body's `@` list, or Insert ▸ Mention, offers dx there.
 *  5. The switcher offers Move to Folder for an artifact alone in its home,
 *     Delete says it leaves "this Thread", or a delete strands the person on
 *     a page for an artifact that is gone.
 *  6. The fix goes too far: a Thread's artifact opened from the library
 *     loses Notify agent and Ask @dx, which still reach its agent; or one
 *     inside a Thread loses Send to Thread or Move to Folder.
 */
import type { ThreadArtifact, ThreadArtifactComment } from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { AuthContext } from "../../../shared/auth/auth-context.js";
import { createQueryClient } from "../../../shared/query/query-client.js";
import { MenuPopup, MenuRoot, MenuTrigger } from "../../../shared/ui/menu.js";
import { threadMembersQueryOptions } from "../../threads/sharing/thread-chat-queries.js";
import { artifactCommentsOptions } from "../artifact-comments-queries.js";
import { ArtifactEditor } from "../editor/artifact-editor.js";
import { LibraryArtifactPage } from "./library-artifact-page.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const userId = "usr_library_viewer" as UserId;
const home = "thr_00000000-0000-4000-8000-0000000000a1" as ThreadId;
const ARTIFACT = `art_${"e".repeat(32)}`;
const QUOTE = "Ship it";
const COMMENT = `cmt_${"2".repeat(32)}`;

type Source = "standalone" | "thread";

const artifact = (): ThreadArtifact => ({
  id: ARTIFACT,
  threadId: home,
  kind: "document",
  folder: "",
  title: "Launch notes",
  revision: 1,
  sizeBytes: 0,
  createdBy: { kind: "user", userId, name: "Viewer Self" },
  updatedBy: { kind: "user", userId, name: "Viewer Self" },
  openCommentCount: 1,
  createdAt: 0,
  updatedAt: 0,
});

const libraryItem = (source: Source) => ({
  id: ARTIFACT,
  kind: "document",
  title: "Launch notes",
  threadId: home,
  source:
    source === "standalone"
      ? { kind: "standalone" }
      : { kind: "thread", title: "Launch Thread", archived: false },
  owner: { userId, name: "Viewer Self" },
  access: "owner",
  sharing: "edit",
  revision: 1,
  updatedBy: { kind: "user", userId, name: "Viewer Self" },
  createdAt: 0,
  updatedAt: 0,
});

const comment = (): ThreadArtifactComment => ({
  id: COMMENT,
  artifactId: ARTIFACT,
  parentId: null,
  quote: QUOTE,
  target: null,
  anchor: { revision: 1, start: 0, end: QUOTE.length },
  author: { kind: "user", userId: "usr_maya", name: "Maya Member" },
  body: "Is this the final date?",
  createdAt: 1,
  resolvedAt: null,
});

let root: Root | undefined;
let deleted: string[] = [];
afterEach(async () => {
  await React.act(() => root?.unmount());
  root = undefined;
  deleted = [];
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (check: () => boolean, ms = 4000) => {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until)
      throw new Error(
        `Timed out waiting, on: ${document.body.innerHTML.slice(-2500)}`,
      );
    await React.act(() => settle(40));
  }
};

const stubServer = (source: Source) =>
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      String(input instanceof Request ? input.url : input),
      window.location.href,
    ).pathname;
    const method =
      init?.method ?? (input instanceof Request ? input.method : "GET");
    const ok = (data: unknown) =>
      Promise.resolve(Response.json({ status: "success", data }));
    if (method === "GET" && url === `/v1/artifacts/${ARTIFACT}`)
      return ok({ item: libraryItem(source) });
    if (method === "GET" && url === `/v1/threads/${home}/artifacts/${ARTIFACT}`)
      return ok({ artifact: artifact(), markdown: `${QUOTE} on Friday.\n` });
    if (
      method === "DELETE" &&
      url === `/v1/threads/${home}/artifacts/${ARTIFACT}`
    ) {
      deleted.push(url);
      return ok({ deleted: true });
    }
    // The Thread's list, for Move to Folder; Delete refreshes it.
    if (method === "GET" && url === `/v1/threads/${home}/artifacts`)
      return ok({ artifacts: deleted.length > 0 ? [] : [artifact()] });
    // Once deleted, what Delete refreshes is gone; before, the rest waits.
    if (deleted.length > 0)
      return Promise.resolve(
        Response.json(
          {
            status: "error",
            data: {
              code: "ARTIFACT_NOT_FOUND",
              message: "Artifact not found.",
            },
          },
          { status: 404 },
        ),
      );
    return new Promise<Response>(() => {});
  });

/** Seeds what the editor reads besides the artifact: its comment, people. */
const seed = (client: ReturnType<typeof createQueryClient>) => {
  client.setQueryData(artifactCommentsOptions(home, ARTIFACT).queryKey, [
    comment(),
  ]);
  client.setQueryData(threadMembersQueryOptions(userId, home).queryKey, [
    {
      userId: "usr_maya",
      name: "Maya Member",
      handle: "maya",
      email: "maya@example.com",
    },
  ] as never);
};

const render = async (
  client: ReturnType<typeof createQueryClient>,
  node: React.ReactNode,
) => {
  const container = document.body.appendChild(document.createElement("div"));
  container.style.cssText = "height:900px;width:1200px;display:flex";
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
          {node}
        </AuthContext>
      </QueryClientProvider>,
    ),
  );
  await waitFor(() => document.querySelector(".artifact-prose") !== null);
  await settle(200);
};

/** The library page at `/artifacts/<id>`, beside the library itself. */
const openInLibrary = async (source: Source) => {
  stubServer(source);
  const client = createQueryClient();
  seed(client);
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/artifacts",
        component: () => <p>The library</p>,
      }),
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/artifacts/$artifactId",
        component: () => (
          <LibraryArtifactPage artifactId={ARTIFACT} presence={() => null} />
        ),
      }),
    ]),
    history: createMemoryHistory({
      initialEntries: [`/artifacts/${ARTIFACT}`],
    }),
  });
  await render(client, <RouterProvider router={router} />);
  return router;
};

/** The same artifact in its Thread's Artifacts view. */
const openInThread = async () => {
  stubServer("thread");
  const client = createQueryClient();
  seed(client);
  const editor = (
    <ArtifactEditor
      threadId={home}
      initial={{ artifact: artifact(), markdown: `${QUOTE} on Friday.\n` }}
      readOnly={false}
      switcher={(extra) => (
        <MenuRoot>
          <MenuTrigger aria-label="Artifact actions">Launch notes</MenuTrigger>
          <MenuPopup>{extra}</MenuPopup>
        </MenuRoot>
      )}
    />
  );
  const router = createRouter({
    routeTree: createRootRoute({ component: () => editor }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await render(client, <RouterProvider router={router} />);
};

const prose = () => {
  const found = document.querySelector<HTMLElement>(".artifact-prose");
  if (found === null) throw new Error("Expected the editor.");
  return found;
};

const notifyAgent = () =>
  document.querySelector(
    '[aria-label="Artifact tools"] .artifact-notify-agent',
  );

/** Selects `text` in the text node that holds it, as a drag would. */
const select = async (text: string) => {
  const walker = document.createTreeWalker(prose(), NodeFilter.SHOW_TEXT);
  let node: Text | undefined;
  for (let next = walker.nextNode(); next !== null; next = walker.nextNode())
    if ((next as Text).data.includes(text)) {
      node = next as Text;
      break;
    }
  if (node === undefined) throw new Error(`No text node for ${text}`);
  const start = node.data.indexOf(text);
  prose().focus();
  getSelection()?.setBaseAndExtent(node, start, node, start + text.length);
  document.dispatchEvent(new Event("selectionchange"));
  await settle();
  await settle();
};

const selectionActions = () =>
  [
    ...document.querySelectorAll<HTMLButtonElement>(
      '[role="toolbar"][aria-label="Selection"] button',
    ),
  ].map((button) => button.getAttribute("aria-label"));

/** Opens the comment's card by its highlight; returns the reply box. */
const openComment = async () => {
  const highlight = document.querySelector<HTMLElement>(
    ".artifact-comment-anchor",
  );
  if (highlight === null) throw new Error("No comment highlight.");
  await userEvent.click(highlight);
  await waitFor(
    () =>
      document.querySelector('[role="dialog"][aria-label="Comment"]') !== null,
  );
  const panel = document.querySelector<HTMLElement>(
    '[role="dialog"][aria-label="Comment"]',
  );
  const reply = panel?.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Reply"]',
  );
  if (
    panel === null ||
    panel === undefined ||
    reply === null ||
    reply === undefined
  )
    throw new Error("No reply box.");
  return { panel, reply };
};

const mentionRows = (selector: string) =>
  [
    ...document.querySelectorAll<HTMLElement>(
      `${selector} [role="option"] .artifact-suggest-label`,
    ),
  ].map((row) => row.textContent);

/** Who the comment box's `@` offers. */
const commentMentions = async (reply: HTMLTextAreaElement) => {
  await userEvent.click(reply);
  await userEvent.keyboard("@");
  await settle();
  return mentionRows('[role="listbox"][aria-label="Mention someone"]');
};

/** Who the body's `@` offers, typed at the end of the document. */
const bodyMentions = async () => {
  await userEvent.click(prose());
  await userEvent.keyboard("{Control>}{End}{/Control} @");
  await settle();
  return mentionRows(".artifact-suggest");
};

const openMenu = async (label: string) => {
  const trigger = document.querySelector<HTMLElement>(
    `[aria-label="${label}"]`,
  );
  if (trigger === null) throw new Error(`No ${label} menu.`);
  await userEvent.click(trigger);
  await settle(150);
};

const menuItems = () =>
  [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((item) =>
    item.textContent?.trim(),
  );

const closeMenus = async () => {
  await userEvent.keyboard("{Escape}");
  await settle();
};

describe("a standalone artifact in the library", () => {
  it("offers no Notify agent, no Send to Thread, and no Ask @dx", async () => {
    await openInLibrary("standalone");
    expect(notifyAgent()).toBeNull();

    await select("on Friday");
    expect(selectionActions()).toContain("Comment");
    expect(selectionActions()).toContain("Copy as Markdown");
    expect(selectionActions()).not.toContain("Send to Thread");

    const { panel, reply } = await openComment();
    expect(panel.querySelector('button[aria-label="Ask @dx"]')).toBeNull();
    expect(await commentMentions(reply)).toEqual(["Maya Member", "here"]);
  });

  it("offers no dx in the body's @ list or Insert ▸ Mention", async () => {
    await openInLibrary("standalone");
    expect(await bodyMentions()).toEqual(["Maya Member"]);
    await closeMenus();

    await openMenu("Insert");
    const mention = [
      ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ].find((item) => item.textContent?.includes("Mention"));
    if (mention === undefined) throw new Error("No Mention submenu.");
    await userEvent.hover(mention);
    await userEvent.click(mention);
    await waitFor(() => menuItems().some((label) => label === "@Maya Member"));
    expect(menuItems()).not.toContain("@dx (the agent)");
  });

  it("has no folder to move to, and Delete goes back to the library", async () => {
    const router = await openInLibrary("standalone");
    await openMenu("Artifact actions");
    expect(menuItems()).not.toContain("Move to Folder…");
    const remove = [
      ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ].find((item) => item.textContent?.includes("Delete Artifact"));
    if (remove === undefined) throw new Error("No Delete Artifact.");
    await userEvent.click(remove);
    await waitFor(
      () =>
        document.querySelector(".confirm-dialog-viewport [role=dialog]") !==
        null,
    );
    const dialog = document.querySelector<HTMLElement>(
      ".confirm-dialog-viewport [role=dialog]",
    );
    expect(dialog?.textContent).toContain("everyone who can open it");
    expect(dialog?.textContent).not.toContain("this Thread");
    const confirm = [
      ...(dialog?.querySelectorAll<HTMLButtonElement>("button") ?? []),
    ].find((button) => button.textContent === "Delete");
    if (confirm === undefined) throw new Error("No Delete button.");
    await userEvent.click(confirm);
    await waitFor(() => router.state.location.pathname === "/artifacts");
    expect(deleted).toEqual([`/v1/threads/${home}/artifacts/${ARTIFACT}`]);
    expect(document.body.textContent).toContain("The library");
  });
});

describe("a Thread's artifact", () => {
  it("opened from the library keeps Notify agent and Ask @dx, without Send to Thread", async () => {
    await openInLibrary("thread");
    expect(notifyAgent()).not.toBeNull();

    await select("on Friday");
    expect(selectionActions()).not.toContain("Send to Thread");

    const { panel, reply } = await openComment();
    expect(panel.querySelector('button[aria-label="Ask @dx"]')).not.toBeNull();
    expect(await commentMentions(reply)).toEqual(["dx", "Maya Member", "here"]);
  });

  it("inside its Thread keeps every agent and Thread action", async () => {
    await openInThread();
    expect(notifyAgent()).not.toBeNull();

    await select("on Friday");
    expect(selectionActions()).toContain("Send to Thread");
    await closeMenus();

    expect(await bodyMentions()).toEqual(["dx", "Maya Member"]);
    await closeMenus();

    const { panel } = await openComment();
    expect(panel.querySelector('button[aria-label="Ask @dx"]')).not.toBeNull();
    await closeMenus();

    await openMenu("Artifact actions");
    expect(menuItems()).toContain("Move to Folder…");
  });
});
