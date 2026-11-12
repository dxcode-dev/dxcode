/**
 * The artifact switcher's file actions, as the reference editor has them
 * (audit 2026-11-06): Move to Folder… and Delete Artifact…, beside New
 * Artifact; and Copy Link, for anyone who can open it.
 *
 * Ways it can fail, each covered below:
 *  1. Move saves no folder, saves the wrong one, or rewrites the content.
 *  2. Delete deletes without asking, or Cancel still deletes.
 *  3. A reader who cannot edit is offered either action.
 *  4. Copy Link copies something other than the link that opens this
 *     artifact (and embeds a board in a document), or a reader lacks it.
 */
import { Menu } from "@base-ui/react/menu";
import type { ThreadArtifact } from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import { QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { AuthContext } from "../../../shared/auth/auth-context.js";
import { createQueryClient } from "../../../shared/query/query-client.js";
import { ArtifactEditor } from "./artifact-editor.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const threadId = "thr_00000000-0000-4000-8000-0000000000a3" as ThreadId;
const userId = "usr_files" as UserId;
const artifact: ThreadArtifact = {
  id: `art_${"a".repeat(32)}`,
  threadId,
  kind: "document",
  folder: "",
  title: "Plan",
  revision: 4,
  sizeBytes: 0,
  createdBy: { kind: "agent" },
  updatedBy: { kind: "agent" },
  openCommentCount: 0,
  createdAt: 0,
  updatedAt: 0,
};
const MARKDOWN = "Ship it.\n";

let root: Root | undefined;
let calls: Array<{ method: string; url: string; body: unknown }> = [];
afterEach(async () => {
  await React.act(() => root?.unmount());
  root = undefined;
  calls = [];
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const mount = async (readOnly = false) => {
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    if (method === "GET") return new Promise<Response>(() => {});
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body });
    if (method === "PUT")
      return Promise.resolve(
        Response.json({
          status: "success",
          data: {
            artifact: {
              ...artifact,
              revision: artifact.revision + 1,
              folder: (body as { folder?: string }).folder ?? artifact.folder,
            },
            markdown: (body as { markdown: string }).markdown,
          },
        }),
      );
    return Promise.resolve(
      Response.json({ status: "success", data: { deleted: true } }),
    );
  });
  const container = document.body.appendChild(document.createElement("div"));
  container.style.cssText = "height:700px;width:900px;display:flex";
  root = createRoot(container);
  await React.act(() =>
    root?.render(
      <QueryClientProvider client={createQueryClient()}>
        <AuthContext
          value={{
            identity: { id: userId, name: "Fil", email: "f@dx.test" },
            logout: () => undefined,
          }}
        >
          <ArtifactEditor
            threadId={threadId}
            initial={{ artifact, markdown: MARKDOWN }}
            readOnly={readOnly}
            switcher={(items) => (
              <Menu.Root>
                <Menu.Trigger aria-label="Switch Artifact">Plan</Menu.Trigger>
                <Menu.Portal>
                  <Menu.Positioner>
                    <Menu.Popup aria-label="Artifacts">
                      <Menu.Item>Plan</Menu.Item>
                      {items}
                    </Menu.Popup>
                  </Menu.Positioner>
                </Menu.Portal>
              </Menu.Root>
            )}
          />
        </AuthContext>
      </QueryClientProvider>,
    ),
  );
  await settle(150);
};

const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));
const openSwitcher = async () => {
  await userEvent.click(page.getByRole("button", { name: "Switch Artifact" }));
  await settle(150);
};
const items = () =>
  [...document.querySelectorAll('[role="menuitem"]')].map((item) =>
    item.textContent?.trim(),
  );

describe("the switcher's file actions", () => {
  it("moves the artifact to a folder, saving only the folder", async () => {
    await mount();
    await openSwitcher();
    expect(items()).toEqual([
      "Plan",
      "Copy Link",
      "Move to Folder…",
      "Delete Artifact…",
    ]);
    await userEvent.click(
      page.getByRole("menuitem", { name: "Move to Folder…" }),
    );
    await settle(150);
    await userEvent.fill(
      page.getByRole("combobox", { name: "Folder" }),
      "Plans",
    );
    await userEvent.click(
      page.getByRole("button", { name: "Move", exact: true }),
    );
    await settle(300);
    expect(calls).toEqual([
      expect.objectContaining({
        method: "PUT",
        body: { baseRevision: 4, markdown: MARKDOWN, folder: "Plans" },
      }),
    ]);
  });

  it("asks before deleting, and Cancel keeps it", async () => {
    await mount();
    await openSwitcher();
    await userEvent.click(
      page.getByRole("menuitem", { name: "Delete Artifact…" }),
    );
    await settle(150);
    await userEvent.click(page.getByRole("button", { name: "Cancel" }));
    await settle(150);
    expect(calls).toEqual([]);
    await openSwitcher();
    await userEvent.click(
      page.getByRole("menuitem", { name: "Delete Artifact…" }),
    );
    await settle(150);
    await userEvent.click(
      page.getByRole("button", { name: "Delete", exact: true }),
    );
    await settle(300);
    expect(calls).toEqual([
      expect.objectContaining({
        method: "DELETE",
        url: expect.stringContaining(`/artifacts/${artifact.id}`),
      }),
    ]);
  });

  it("offers neither to a reader, who can still copy its link", async () => {
    await mount(true);
    await openSwitcher();
    expect(items()).toEqual(["Plan", "Copy Link"]);
    const copied: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => void copied.push(text) },
    });
    await userEvent.click(page.getByRole("menuitem", { name: "Copy Link" }));
    await settle(50);
    expect(copied).toEqual([
      `${window.location.origin}/threads/${artifact.threadId}?artifact=${artifact.id}&sheet=artifact`,
    ]);
  });
});
