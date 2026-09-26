// @vitest-environment happy-dom

import type {
  ThreadChangedFile,
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
import type { ThreadFilesApi } from "./files-api.js";
import { ThreadFilesTree } from "./files-tree.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const threadId = "thr_00000000-0000-4000-8000-000000000244" as ThreadId;
const version = `sha256:${"a".repeat(64)}` as ThreadFileVersion;
const entries = [
  {
    path: "src" as ThreadFilesPath,
    name: "src",
    kind: "directory" as const,
  },
  {
    path: 'odd"[x]' as ThreadFilesPath,
    name: 'odd"[x]',
    kind: "directory" as const,
  },
];
const emptyApi: ThreadFilesApi = {
  list: vi.fn(async (_threadId, path) => ({
    kind: "tree" as const,
    path,
    version,
    entries: [],
  })),
  read: vi.fn(),
  save: vi.fn(),
};

const settle = () =>
  React.act(() => new Promise((resolve) => setTimeout(resolve, 0)));

afterEach(() => {
  focusManager.setFocused(undefined);
  document.body.replaceChildren();
});

describe("ThreadFilesTree presentation", () => {
  it("clears selection without remounting so a closed file can be reopened", async () => {
    const client = new QueryClient();
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    const onOpenFile = vi.fn();
    const file = "README.md" as ThreadFilesPath;
    const render = (selectedPath: ThreadFilesPath | undefined) =>
      root.render(
        <QueryClientProvider client={client}>
          <ThreadFilesTree
            api={emptyApi}
            entries={[{ path: file, name: file, kind: "file" }]}
            gitStatus={new Map()}
            onOpenFile={onOpenFile}
            selectedPath={selectedPath}
            threadId={threadId}
          />
        </QueryClientProvider>,
      );

    await React.act(() => render(file));
    await settle();
    const selectedHost = container.querySelector(
      '[aria-label="Workspace files"]',
    );
    expect(
      selectedHost?.shadowRoot
        ?.querySelector(`[data-item-path="${file}"]`)
        ?.getAttribute("aria-selected"),
    ).toBe("true");
    const selectedRow =
      selectedHost?.shadowRoot?.querySelector<HTMLButtonElement>(
        `[data-item-path="${file}"]`,
      );
    await React.act(() => selectedRow?.focus());
    selectedHost?.setAttribute("data-preserved", "true");

    await React.act(() => render(undefined));
    await settle();
    const reopenedHost = container.querySelector(
      '[aria-label="Workspace files"]',
    );
    const reopenedRow =
      reopenedHost?.shadowRoot?.querySelector<HTMLButtonElement>(
        `[data-item-path="${file}"]`,
      );
    expect(reopenedHost).toBe(selectedHost);
    expect(reopenedHost?.getAttribute("data-preserved")).toBe("true");
    expect(reopenedHost?.shadowRoot?.activeElement).toBe(reopenedRow);
    expect(reopenedRow?.getAttribute("aria-selected")).toBe("false");
    await React.act(() => reopenedRow?.click());
    expect(onOpenFile).toHaveBeenCalledWith(file);
    await React.act(() => root.unmount());
  });

  it("updates ancestor badges when live statuses arrive and clear", async () => {
    const client = new QueryClient();
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    const render = (
      gitStatus: ReadonlyMap<string, ThreadChangedFile["status"]>,
    ) =>
      root.render(
        <QueryClientProvider client={client}>
          <ThreadFilesTree
            api={emptyApi}
            entries={entries}
            gitStatus={gitStatus}
            onOpenFile={vi.fn()}
            threadId={threadId}
          />
        </QueryClientProvider>,
      );

    await React.act(() => render(new Map()));
    await settle();
    const host = container.querySelector('[aria-label="Workspace files"]');
    const src = host?.shadowRoot?.querySelector('[data-item-path="src/"]');
    expect(src?.getAttribute("data-item-git-status")).toBeNull();

    await React.act(() =>
      render(
        new Map([
          ["src/deep/a.ts", "added"],
          ["src/deep/b.ts", "untracked"],
        ]),
      ),
    );
    expect(src?.getAttribute("data-item-git-status")).toBe("modified");
    expect(src?.querySelector('[data-item-section="git"]')?.textContent).toBe(
      "M",
    );

    await React.act(() => render(new Map()));
    expect(src?.getAttribute("data-item-git-status")).toBeNull();
    await React.act(() => root.unmount());
  });

  it("targets a pending directory without remounting the tree", async () => {
    let resolveChildren: ((tree: ThreadFileTreeData) => void) | undefined;
    const children = new Promise<ThreadFileTreeData>((resolve) => {
      resolveChildren = resolve;
    });
    const api: ThreadFilesApi = {
      ...emptyApi,
      list: vi.fn(async () => children),
    };
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    await React.act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <ThreadFilesTree
            api={api}
            entries={entries}
            gitStatus={new Map()}
            onOpenFile={vi.fn()}
            threadId={threadId}
          />
        </QueryClientProvider>,
      ),
    );
    await settle();
    const initialHost = container.querySelector(
      '[aria-label="Workspace files"]',
    );
    const loadingStatus = container.querySelector('[role="status"]');
    expect(loadingStatus?.textContent).toBe("");
    const directory = [
      ...(initialHost?.shadowRoot?.querySelectorAll<HTMLButtonElement>(
        "[data-item-path]",
      ) ?? []),
    ].find((row) => row.getAttribute("data-item-path") === 'odd"[x]/');
    await React.act(() => directory?.click());

    const loadingHost = container.querySelector(
      '[aria-label="Workspace files"]',
    );
    expect(loadingHost?.getAttribute("style")).toContain(
      "color-scheme: inherit",
    );
    expect(container.querySelector('[role="status"]')).toBe(loadingStatus);
    expect(loadingStatus?.textContent).toBe('Loading odd"[x]…');
    expect(loadingHost?.getAttribute("aria-busy")).toBe("true");
    expect(
      [...(loadingHost?.attributes ?? [])].some((attribute) =>
        attribute.name.startsWith("data-loading-directory-"),
      ),
    ).toBe(true);
    expect(loadingHost?.shadowRoot?.textContent).toContain(
      "thread-files-blink",
    );
    const unsafeStyle =
      loadingHost?.shadowRoot?.querySelector<HTMLStyleElement>(
        "style[data-file-tree-unsafe-css]",
      );
    expect(unsafeStyle?.textContent).toContain('data-item-path="odd\\"[x]/"');

    await React.act(() =>
      resolveChildren?.({
        kind: "tree",
        path: 'odd"[x]' as ThreadFilesPath,
        version,
        entries: [],
      }),
    );
    await settle();
    const loadedHost = container.querySelector(
      '[aria-label="Workspace files"]',
    );
    expect(loadedHost).toBe(loadingHost);
    expect(loadedHost?.getAttribute("aria-busy")).toBe("false");
    expect(container.querySelector('[role="status"]')).toBe(loadingStatus);
    expect(loadingStatus?.textContent).toBe("");
    await React.act(() => root.unmount());
  });

  it("keeps expanded directory observers dormant while Files is inactive", async () => {
    const list = vi.fn(async (_threadId, path) => ({
      kind: "tree" as const,
      path,
      version,
      entries: [],
    }));
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    const render = (active: boolean) =>
      root.render(
        <QueryClientProvider client={client}>
          <ThreadFilesTree
            active={active}
            api={{ ...emptyApi, list }}
            entries={entries}
            gitStatus={new Map()}
            onOpenFile={vi.fn()}
            threadId={threadId}
          />
        </QueryClientProvider>,
      );

    await React.act(() => render(true));
    await settle();
    const host = container.querySelector('[aria-label="Workspace files"]');
    const directory = host?.shadowRoot?.querySelector<HTMLButtonElement>(
      '[data-item-path="src/"]',
    );
    await React.act(() => directory?.click());
    await settle();
    expect(list).toHaveBeenCalledOnce();

    await React.act(() => render(false));
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await settle();
    expect(list).toHaveBeenCalledOnce();
    await React.act(() => root.unmount());
  });
});
