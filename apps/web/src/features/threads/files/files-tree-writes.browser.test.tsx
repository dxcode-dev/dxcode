import type {
  ThreadFilesPath,
  ThreadFileTreeData,
  ThreadFileVersion,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import {
  focusManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChangesTransport } from "../changes/changes-api.js";
import type { ThreadFilesApi } from "./files-api.js";
import { ThreadFilesPanel } from "./files-panel.js";

/*
 * The Files tree's write actions (#1154), on the real tree component.
 *
 * Ways this could fail, each covered below:
 * - a View member sees a write action in the toolbar or a row's menu;
 * - a menu lacks an action the reference shows, or runs another one;
 * - Duplicate, Paste, or New File names collide with an existing entry;
 * - Delete runs without asking, or Cancel still deletes;
 * - Cut then Paste copies instead of moving, or pastes into the wrong folder;
 * - Upload sends the file somewhere other than the folder it was asked for;
 * - a refused write fails silently.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const threadId = "thr_00000000-0000-4000-8000-000000001154" as ThreadId;
const version = `sha256:${"a".repeat(64)}` as ThreadFileVersion;
const rootTree: ThreadFileTreeData = {
  kind: "tree",
  version,
  entries: [
    {
      path: "README.md" as ThreadFilesPath,
      name: "README.md",
      kind: "file",
      sizeBytes: 12,
    },
    {
      path: "README copy.md" as ThreadFilesPath,
      name: "README copy.md",
      kind: "file",
      sizeBytes: 12,
    },
    { path: "src" as ThreadFilesPath, name: "src", kind: "directory" },
  ],
};

const changes: ChangesTransport = {
  getChanges: vi.fn(async () => ({ kind: "missing" as const })),
  getDiff: vi.fn(),
  push: vi.fn(),
};

const settle = () =>
  React.act(() => new Promise((resolve) => setTimeout(resolve, 0)));

afterEach(() => {
  focusManager.setFocused(undefined);
  document.body.replaceChildren();
});

const render = async (canWrite: boolean, transport: ThreadFilesApi) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  await React.act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <ThreadFilesPanel
          canWrite={canWrite}
          changesTransport={changes}
          onOpenFile={vi.fn()}
          threadId={threadId}
          transport={transport}
        />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(
    () =>
      expect(
        container
          .querySelector('[aria-label="Workspace files"]')
          ?.shadowRoot?.querySelector('[data-item-path="README.md"]'),
      ).toBeTruthy(),
    { timeout: 5_000 },
  );
  return { container, root };
};

const transport = () => {
  const api = {
    list: vi.fn(async () => rootTree),
    read: vi.fn(),
    save: vi.fn(),
    write: vi.fn(async () => ({ kind: "changed" as const })),
    upload: vi.fn(async () => ({ kind: "changed" as const })),
  };
  return api satisfies ThreadFilesApi;
};

const row = (container: HTMLElement, path: string) =>
  container
    .querySelector('[aria-label="Workspace files"]')
    ?.shadowRoot?.querySelector<HTMLElement>(`[data-item-path="${path}"]`) ??
  null;

/** Right-clicks a row and returns its menu's item labels. */
const openMenu = async (container: HTMLElement, path: string) => {
  const target = row(container, path);
  await React.act(() => {
    target?.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        composed: true,
        cancelable: true,
        button: 2,
      }),
    );
  });
  await settle();
  const menu = document.querySelector<HTMLElement>(
    ".thread-files-tree-menu[role='menu']",
  );
  return [
    ...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []),
  ].map(itemLabel);
};

/** An item's label, then its shortcut's keys when it shows one. */
function itemLabel(item: HTMLElement) {
  const keys = item.querySelector(".shortcut-keycaps");
  const label = [...item.childNodes]
    .filter((node) => node !== keys)
    .map((node) => node.textContent ?? "")
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return keys === null
    ? label
    : `${label} [${[...keys.querySelectorAll("kbd")].map((key) => key.textContent).join("+")}]`;
}

const clickMenuItem = async (label: string) => {
  const item = [
    ...document.querySelectorAll<HTMLElement>(
      '.thread-files-tree-menu [role="menuitem"]',
    ),
  ].find(
    (candidate) =>
      itemLabel(candidate).replace(/ \[.*\]$/, "") === label ||
      itemLabel(candidate).startsWith(`${label} “`),
  );
  expect(item, label).toBeDefined();
  await React.act(() => item?.click());
  await settle();
};

const toolbarLabels = (container: HTMLElement) =>
  [
    ...container.querySelectorAll<HTMLButtonElement>(
      '[aria-label="Files actions"] button',
    ),
  ].map((button) => button.getAttribute("aria-label"));

describe("Files tree write actions", () => {
  it("gives a View member no write action", async () => {
    const api = transport();
    const { container, root } = await render(false, api);
    expect(toolbarLabels(container)).toEqual(["Collapse All Folders"]);
    expect(container.querySelector('input[type="file"]')).toBeNull();
    expect(await openMenu(container, "README.md")).toEqual([
      "Open",
      "Download",
      "Copy Path",
    ]);
    expect(await openMenu(container, "src/")).toEqual(["Expand", "Copy Path"]);
    expect(api.write).not.toHaveBeenCalled();
    await React.act(() => root.unmount());
  });

  it("offers the reference's toolbar and menus to people who write", async () => {
    const { container, root } = await render(true, transport());
    expect(toolbarLabels(container)).toEqual([
      "New File",
      "New Folder",
      "Upload Files",
      "Collapse All Folders",
    ]);
    // The platform's modifier: Ctrl, or ⌘ on a Mac.
    const mod = (label: string) => label.replace(/\[(Ctrl|⌘)\+/, "[Mod+");
    const edits = [
      "Cut [Mod+X]",
      "Copy [Mod+C]",
      "Duplicate",
      "Rename… [F2]",
      "Delete [Delete]",
    ];
    expect((await openMenu(container, "README.md")).map(mod)).toEqual([
      "New File…",
      "New Folder…",
      "Open",
      "Download",
      "Copy Path",
      ...edits,
    ]);
    expect((await openMenu(container, "src/")).map(mod)).toEqual([
      "Expand",
      "New File…",
      "New Folder…",
      "Copy Path",
      "Upload Files…",
      ...edits,
    ]);
    await React.act(() => root.unmount());
  });

  it("duplicates beside the original under a free name", async () => {
    const api = transport();
    const { container, root } = await render(true, api);
    await openMenu(container, "README.md");
    await clickMenuItem("Duplicate");
    // "README copy.md" exists, so the copy is the next free name.
    expect(api.write).toHaveBeenCalledWith(
      threadId,
      { action: "copy", from: "README.md", to: "README copy 2.md" },
      "primary",
    );
    await React.act(() => root.unmount());
  });

  it("moves on Cut then Paste into a folder, and copies on Copy", async () => {
    const api = transport();
    const { container, root } = await render(true, api);
    await openMenu(container, "README.md");
    await clickMenuItem("Cut");
    const pasteLabels = await openMenu(container, "src/");
    expect(pasteLabels).toContainEqual(
      expect.stringMatching(/^Paste “README.md” \[/),
    );
    await clickMenuItem("Paste");
    expect(api.write).toHaveBeenLastCalledWith(
      threadId,
      { action: "move", from: "README.md", to: "src/README.md" },
      "primary",
    );
    // A cut pastes once.
    expect(
      (await openMenu(container, "src/")).some((label) =>
        label.startsWith("Paste"),
      ),
    ).toBe(false);

    await openMenu(container, "README.md");
    await clickMenuItem("Copy");
    await openMenu(container, "src/");
    await clickMenuItem("Paste");
    expect(api.write).toHaveBeenLastCalledWith(
      threadId,
      { action: "copy", from: "README.md", to: "src/README.md" },
      "primary",
    );
    await React.act(() => root.unmount());
  });

  it("asks before deleting, and Cancel deletes nothing", async () => {
    const api = transport();
    const { container, root } = await render(true, api);
    await openMenu(container, "src/");
    await clickMenuItem("Delete");
    const dialog = () =>
      document.querySelector<HTMLElement>('[aria-label="Delete folder"]');
    expect(dialog()?.textContent).toContain(
      "“src” and everything in it will be deleted from the workspace.",
    );
    const button = (label: string) =>
      [...(dialog()?.querySelectorAll("button") ?? [])].find(
        (candidate) => candidate.textContent?.trim() === label,
      ) ?? null;
    await React.act(() => button("Cancel")?.click());
    await settle();
    expect(dialog()).toBeNull();
    expect(api.write).not.toHaveBeenCalled();

    await openMenu(container, "README.md");
    await clickMenuItem("Delete");
    const confirm = [
      ...(document
        .querySelector('[aria-label="Delete file"]')
        ?.querySelectorAll("button") ?? []),
    ].find((candidate) => candidate.textContent?.trim() === "Delete");
    await React.act(() => confirm?.click());
    await settle();
    expect(api.write).toHaveBeenCalledWith(
      threadId,
      { action: "delete", path: "README.md" },
      "primary",
    );
    await vi.waitFor(() =>
      expect(document.querySelector('[aria-label="Delete file"]')).toBeNull(),
    );
    await React.act(() => root.unmount());
  });

  it("uploads into the folder it was asked for and says when a write is refused", async () => {
    const api = transport();
    api.upload.mockRejectedValueOnce(
      Object.assign(
        new (await import("./files-api.js")).ThreadFilesApiError(
          409,
          "THREAD_FILES_CONFLICT",
          "The file changed before the operation completed.",
        ),
      ),
    );
    const { container, root } = await render(true, api);
    const input =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    const click = vi.spyOn(input as HTMLInputElement, "click");
    await openMenu(container, "src/");
    await clickMenuItem("Upload Files…");
    expect(click).toHaveBeenCalledOnce();
    const chosen = new File(["hello"], "notes.txt", { type: "text/plain" });
    const files = new DataTransfer();
    files.items.add(chosen);
    await React.act(() => {
      if (input === null) return;
      input.files = files.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
    expect(api.upload).toHaveBeenCalledWith(
      threadId,
      "src/notes.txt",
      chosen,
      "primary",
    );
    await vi.waitFor(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        "“notes.txt” already exists there.",
      ),
    );
    await React.act(() => root.unmount());
  });
});
