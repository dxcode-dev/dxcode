/**
 * Linked artifacts, Notion style: a line of a document holding only a link
 * to another artifact shows that artifact's preview below it.
 *
 * Ways it can fail, each covered below:
 *  1. An `/artifacts/<id>` link (every artifact's link) shows nothing.
 *  2. A linked document shows nothing, or not its opening lines; only
 *     boards preview.
 *  3. A linked board stops previewing through the new link.
 *  4. A link to the artifact itself embeds itself.
 *  5. A link the reader cannot open shows anything of it, or breaks the
 *     document instead of saying it cannot be opened.
 *  6. Clicking a preview does not open that artifact's link.
 */
import type { ThreadArtifact } from "@dx/api";
import {
  emptyBoard,
  serializeBoard,
  type ThreadId,
  type UserId,
} from "@dx/domain";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { AuthContext } from "../../../shared/auth/auth-context.js";
import { createQueryClient } from "../../../shared/query/query-client.js";
import { ArtifactEditor } from "./artifact-editor.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const homeThread = "thr_00000000-0000-4000-8000-0000000000e1" as ThreadId;
const otherThread = "thr_00000000-0000-4000-8000-0000000000e2" as ThreadId;
const userId = "usr_embeds" as UserId;
const id = (letter: string) => `art_${letter.repeat(32)}`;
const SELF = id("a");
const SPEC = id("b");
const BOARD = id("c");
const HIDDEN = id("d");

const artifact = (
  artifactId: string,
  threadId: ThreadId,
  title: string,
  kind: "document" | "board" = "document",
): ThreadArtifact => ({
  id: artifactId,
  threadId,
  kind,
  folder: "",
  title,
  revision: 1,
  sizeBytes: 0,
  createdBy: { kind: "agent" },
  updatedBy: { kind: "agent" },
  openCommentCount: 0,
  createdAt: 0,
  updatedAt: 0,
});

/** What the library says about each linked artifact the reader may open. */
const libraryItem = (
  artifactId: string,
  threadId: ThreadId,
  title: string,
) => ({
  id: artifactId,
  kind: artifactId === BOARD ? "board" : "document",
  title,
  threadId,
  source: { kind: "standalone" },
  owner: { userId: "usr_owner", name: "Olive" },
  access: "edit",
  sharing: "edit",
  revision: 1,
  updatedBy: { kind: "agent" },
  createdAt: 0,
  updatedAt: 0,
});

const SPEC_MARKDOWN =
  "# Checkout spec\n\nFirst point of the spec, for {{project:prj_00000000-0000-4000-8000-000000000001|Storefront}}.\n\n- [ ] Second, a task\n";

const MARKDOWN = [
  "Our linked docs:",
  "",
  `[Spec](/artifacts/${SPEC})`,
  "",
  `[Flow](/artifacts/${BOARD})`,
  "",
  `[This page](/artifacts/${SELF})`,
  "",
  `[Secret](/artifacts/${HIDDEN})`,
  "",
].join("\n");

const fetched: string[] = [];
const notFound = () =>
  Response.json(
    {
      status: "error",
      data: { code: "ARTIFACT_NOT_FOUND", message: "Artifact not found." },
    },
    { status: 404 },
  );

const stubServer = () =>
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      String(input instanceof Request ? input.url : input),
      window.location.href,
    ).pathname;
    if ((init?.method ?? "GET") !== "GET")
      return new Promise<Response>(() => {});
    fetched.push(url);
    const ok = (data: unknown) =>
      Promise.resolve(Response.json({ status: "success", data }));
    if (url === `/v1/artifacts/${SPEC}`)
      return ok({ item: libraryItem(SPEC, otherThread, "Checkout spec") });
    if (url === `/v1/artifacts/${BOARD}`)
      return ok({ item: libraryItem(BOARD, otherThread, "Checkout flow") });
    if (url === `/v1/threads/${otherThread}/artifacts/${SPEC}`)
      return ok({
        artifact: artifact(SPEC, otherThread, "Checkout spec"),
        markdown: SPEC_MARKDOWN,
      });
    if (url === `/v1/threads/${otherThread}/artifacts/${BOARD}`)
      return ok({
        artifact: artifact(BOARD, otherThread, "Checkout flow", "board"),
        markdown: serializeBoard(emptyBoard()),
      });
    if (url.includes("/comments")) return ok({ comments: [] });
    return Promise.resolve(notFound());
  });

let root: Root | undefined;
afterEach(async () => {
  await React.act(() => root?.unmount());
  root = undefined;
  fetched.length = 0;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const mount = async () => {
  stubServer();
  const editor = (
    <ArtifactEditor
      threadId={homeThread}
      initial={{
        artifact: artifact(SELF, homeThread, "Team hub"),
        markdown: MARKDOWN,
      }}
      readOnly
      switcher={() => <span>Team hub</span>}
    />
  );
  const router = createRouter({
    routeTree: createRootRoute({ component: () => editor }),
    history: createMemoryHistory({ initialEntries: [`/artifacts/${SELF}`] }),
  });
  const container = document.body.appendChild(document.createElement("div"));
  container.style.cssText = "height:900px;width:900px;display:flex";
  root = createRoot(container);
  await React.act(() =>
    root?.render(
      <QueryClientProvider client={createQueryClient()}>
        <AuthContext
          value={{
            identity: { id: userId, name: "Em", email: "e@dx.test" },
            logout: () => undefined,
          }}
        >
          <RouterProvider router={router} />
        </AuthContext>
      </QueryClientProvider>,
    ),
  );
  return router;
};

const waitFor = async (check: () => boolean, ms = 4000) => {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("Timed out waiting.");
    await React.act(() => new Promise((resolve) => setTimeout(resolve, 40)));
  }
};

describe("linked artifacts in a document", () => {
  it("previews a linked document and board, skips itself, and keeps an unopenable one closed", async () => {
    await mount();
    await waitFor(
      () =>
        document.querySelector('[aria-label="Open document Checkout spec"]') !==
          null &&
        document.querySelector('[aria-label="Open board Checkout flow"]') !==
          null &&
        document.querySelector(".artifact-embed-missing") !== null,
    );

    const documentCard = document.querySelector(
      '[aria-label="Open document Checkout spec"]',
    );
    expect(documentCard?.textContent).toContain("Checkout spec");
    expect(documentCard?.textContent).toContain(
      "First point of the spec, for Storefront.",
    );
    expect(documentCard?.textContent).not.toContain("prj_");
    expect(documentCard?.textContent).toContain("Second, a task");
    expect(documentCard?.textContent).not.toContain("#");

    // One embed each for the spec, the board, and the unopenable link;
    // none for the page's own link.
    expect(document.querySelectorAll(".artifact-embed")).toHaveLength(3);
    expect(fetched).not.toContain(`/v1/artifacts/${SELF}`);
    const missing = document.querySelector(".artifact-embed-missing");
    expect(missing?.textContent).toBe(
      "This artifact is gone, or you can't open it.",
    );
    expect(document.body.textContent).not.toContain("Secret plan");
  });

  it("opens the linked artifact's link when its preview is clicked", async () => {
    const router = await mount();
    await waitFor(
      () =>
        document.querySelector('[aria-label="Open document Checkout spec"]') !==
        null,
    );
    await userEvent.click(
      page.getByRole("button", { name: "Open document Checkout spec" }),
    );
    await waitFor(
      () => router.state.location.pathname === `/artifacts/${SPEC}`,
    );
    expect(router.state.location.pathname).toBe(`/artifacts/${SPEC}`);
  });
});
