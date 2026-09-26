// @vitest-environment happy-dom

import type {
  ThreadChangedFile,
  ThreadChangesData,
  ThreadChangesPath,
  ThreadFilesCursor,
  ThreadFilesPath,
  ThreadFilesWorktreeId,
  ThreadFileTreeData,
  ThreadFileVersion,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import {
  focusManager,
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const treeHarness = vi.hoisted(() => {
  type Options = {
    paths: readonly string[];
    gitStatus?: readonly {
      path: string;
      status: string;
    }[];
    onSelectionChange: (paths: readonly string[]) => void;
  };
  const create = (options: Options) => {
    let expanded = [
      ...((options as Options & { initialExpandedPaths?: readonly string[] })
        .initialExpandedPaths ?? []),
    ];
    let gitStatus = new Map(
      options.gitStatus?.map((entry) => [entry.path, entry.status]),
    );
    let revision = 0;
    const listeners = new Set<() => void>();
    const notify = () => {
      revision += 1;
      for (const listener of listeners) listener();
    };
    return {
      getGitStatus: (path: string) => gitStatus.get(path),
      getItemHeight: () => 30,
      getRevision: () => revision,
      getVisibleCount: () => options.paths.length,
      getVisibleRows: () =>
        options.paths.map((path) => ({
          kind: path.endsWith("/") ? "directory" : "file",
          path,
          isExpanded: expanded.includes(path),
        })),
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      setGitStatus: (entries: readonly { path: string; status: string }[]) => {
        gitStatus = new Map(entries.map((entry) => [entry.path, entry.status]));
        notify();
      },
      expand: (path: string) => {
        expanded = [...expanded, path];
        notify();
      },
      select: (path: string) => options.onSelectionChange([path]),
    };
  };
  return { create };
});

vi.mock("@pierre/trees/react", async () => {
  const ReactModule = await import("react");
  return {
    useFileTree: (options: Parameters<typeof treeHarness.create>[0]) => {
      const [model] = ReactModule.useState(() => treeHarness.create(options));
      return { model };
    },
    FileTree: ({
      model,
      ...props
    }: React.HTMLAttributes<HTMLDivElement> & {
      model: ReturnType<typeof treeHarness.create>;
    }) => {
      ReactModule.useSyncExternalStore(
        model.subscribe,
        model.getRevision,
        model.getRevision,
      );
      return (
        <div {...props}>
          {model.getVisibleRows().map((row) => (
            <button
              data-git-status={model.getGitStatus(row.path)}
              type="button"
              key={row.path}
              onClick={() =>
                row.kind === "directory"
                  ? model.expand(row.path)
                  : model.select(row.path)
              }
            >
              {row.path}
            </button>
          ))}
        </div>
      );
    },
  };
});

vi.mock("./file-viewer.js", async () => {
  const ReactModule = await import("react");
  return {
    ThreadFileViewer: ({
      file,
      connectionMessage,
    }: {
      file: { path: string };
      connectionMessage?: string;
    }) =>
      ReactModule.createElement(
        "section",
        { "aria-label": `File ${file.path}` },
        connectionMessage,
      ),
  };
});

import type { ChangesTransport } from "../changes/changes-api.js";
import { changesKeys } from "../changes/changes-queries.js";
import { ThreadDesktopLayout } from "../thread-desktop-layout.js";
import type { ThreadFilesApi } from "./files-api.js";
import { ThreadFilePane, ThreadFilesPanel } from "./files-panel.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const threadId = "thr_00000000-0000-4000-8000-000000000243" as ThreadId;
const primaryWorktree = "primary" as ThreadFilesWorktreeId;
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
    { path: "src" as ThreadFilesPath, name: "src", kind: "directory" },
  ],
};
const sourceTree: ThreadFileTreeData = {
  kind: "tree",
  path: "src" as ThreadFilesPath,
  version,
  entries: [
    {
      path: "src/index.ts" as ThreadFilesPath,
      name: "index.ts",
      kind: "file",
      sizeBytes: 20,
    },
  ],
};

const settle = () =>
  React.act(() => new Promise((resolve) => setTimeout(resolve, 0)));

const changesData = (
  files: readonly Pick<ThreadChangedFile, "path" | "status">[],
  freshness: ThreadChangesData["freshness"] = "complete",
) =>
  ({
    kind: "changes",
    captureId: "capture-files-test",
    freshness,
    capturedAt: "2026-09-09T12:00:00.000Z",
    range: { kind: "uncommitted" },
    truncated: false,
    baseline: "a".repeat(40),
    head: "b".repeat(40),
    ahead: 0,
    summary: { additions: 0, deletions: 0, files: files.length },
    files: files.map((file) => ({
      ...file,
      additions: 0,
      deletions: 0,
      binary: false,
      truncated: false,
    })),
    commits: [],
  }) as unknown as ThreadChangesData;

const createChangesTransport = (
  getChanges: ChangesTransport["getChanges"] = async () => ({
    kind: "missing",
  }),
): ChangesTransport => ({
  getChanges: vi.fn(getChanges),
  getDiff: vi.fn(),
  push: vi.fn(),
});

afterEach(() => {
  focusManager.setFocused(undefined);
  onlineManager.setOnline(true);
  document.body.replaceChildren();
});

describe("Thread Files lazy reads", () => {
  it("opens a running workspace directly from the Files tab", async () => {
    const transport: ThreadFilesApi = {
      list: vi.fn(async () => rootTree),
      read: vi.fn(),
      save: vi.fn(),
    };
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    await React.act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <ThreadDesktopLayout
            changes={<div>Changes</div>}
            files={
              <ThreadFilesPanel
                changesTransport={createChangesTransport()}
                onOpenFile={vi.fn()}
                threadId={threadId}
                transport={transport}
              />
            }
            main={<div>Agent</div>}
            rightPaneCollapsed={false}
          />
        </QueryClientProvider>,
      ),
    );
    expect(transport.list).not.toHaveBeenCalled();

    await React.act(() =>
      container
        .querySelector<HTMLButtonElement>("#thread-workspace-tab-files")
        ?.click(),
    );
    await settle();

    expect(transport.list).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("README.md");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector(".thread-files-worktree")).toBeNull();
    await React.act(() => root.unmount());
  });

  it("sizes grouped worktree trees to their visible rows", async () => {
    const linkedWorktree = "linked" as ThreadFilesWorktreeId;
    const changes = changesData([]);
    const transport: ThreadFilesApi = {
      list: vi.fn(async () => rootTree),
      read: vi.fn(),
      save: vi.fn(),
    };
    const changesTransport = createChangesTransport(async () => ({
      ...changes,
      worktrees: [
        {
          id: primaryWorktree,
          name: "dx",
          head: changes.head,
          branch: "main",
        },
        {
          id: linkedWorktree,
          name: "agent-worktree",
          head: changes.head,
          branch: "agent",
        },
      ],
    }));
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    await React.act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <ThreadFilesPanel
            changesTransport={changesTransport}
            onOpenFile={vi.fn()}
            projectName="dx"
            threadId={threadId}
            transport={transport}
          />
        </QueryClientProvider>,
      ),
    );
    await settle();

    const worktrees = container.querySelectorAll(".thread-files-worktree");
    expect(worktrees).toHaveLength(2);
    await vi.waitFor(() =>
      expect(container.querySelectorAll(".thread-files-tree")).toHaveLength(2),
    );
    for (const worktree of worktrees) {
      const tree = worktree.querySelector<HTMLElement>(".thread-files-tree");
      expect(
        tree?.style.getPropertyValue("--thread-files-tree-content-height"),
      ).toBe("60px");
    }
    await React.act(() => root.unmount());
  });

  it("does not wake retained Files on focus while another tool is active", async () => {
    const transport: ThreadFilesApi = {
      list: vi.fn(async () => rootTree),
      read: vi.fn(),
      save: vi.fn(),
    };
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    await React.act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <ThreadDesktopLayout
            changes={<div>Changes</div>}
            files={(active) => (
              <ThreadFilesPanel
                active={active}
                changesTransport={createChangesTransport()}
                onOpenFile={vi.fn()}
                threadId={threadId}
                transport={transport}
              />
            )}
            main={<div>Agent</div>}
            rightPaneCollapsed={false}
          />
        </QueryClientProvider>,
      ),
    );
    await React.act(() =>
      container
        .querySelector<HTMLButtonElement>("#thread-workspace-tab-files")
        ?.click(),
    );
    await settle();
    expect(transport.list).toHaveBeenCalledOnce();

    await React.act(() =>
      container
        .querySelector<HTMLButtonElement>("#thread-workspace-tab-changes")
        ?.click(),
    );
    await client.invalidateQueries({
      queryKey: ["thread-files", threadId],
      refetchType: "none",
    });
    await React.act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await settle();

    expect(transport.list).toHaveBeenCalledOnce();
    await React.act(() => root.unmount());
  });

  it("refetches retained Files once when the active document returns visible", async () => {
    const transport: ThreadFilesApi = {
      list: vi.fn(async () => rootTree),
      read: vi.fn(),
      save: vi.fn(),
    };
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    await React.act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <ThreadDesktopLayout
            changes={<div>Changes</div>}
            files={(active) => (
              <ThreadFilesPanel
                active={active}
                changesTransport={createChangesTransport()}
                onOpenFile={vi.fn()}
                threadId={threadId}
                transport={transport}
              />
            )}
            main={<div>Agent</div>}
            rightPaneCollapsed={false}
          />
        </QueryClientProvider>,
      ),
    );
    await React.act(() =>
      container
        .querySelector<HTMLButtonElement>("#thread-workspace-tab-files")
        ?.click(),
    );
    await settle();
    await client.invalidateQueries({
      queryKey: ["thread-files", threadId],
      refetchType: "none",
    });

    await React.act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await settle();

    expect(transport.list).toHaveBeenCalledTimes(2);
    await React.act(() => root.unmount());
  });

  it("shows cached Files as disconnected and refetches once when online returns", async () => {
    const transport: ThreadFilesApi = {
      list: vi.fn(async () => rootTree),
      read: vi.fn(),
      save: vi.fn(),
    };
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    await React.act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <ThreadFilesPanel
            active
            changesTransport={createChangesTransport()}
            onOpenFile={vi.fn()}
            threadId={threadId}
            transport={transport}
          />
        </QueryClientProvider>,
      ),
    );
    await settle();
    await client.invalidateQueries({
      queryKey: ["thread-files", threadId],
      refetchType: "none",
    });

    await React.act(async () => onlineManager.setOnline(false));
    expect(container.textContent).toContain("README.md");
    expect(container.textContent).toContain("Disconnected");
    await React.act(async () => onlineManager.setOnline(true));
    await settle();

    expect(transport.list).toHaveBeenCalledTimes(2);
    await React.act(() => root.unmount());
  });

  it("keeps the cached tree visible while a recovery read is reconnecting", async () => {
    let recover: ((tree: ThreadFileTreeData) => void) | undefined;
    const recovery = new Promise<ThreadFileTreeData>((resolve) => {
      recover = resolve;
    });
    const transport: ThreadFilesApi = {
      list: vi
        .fn<ThreadFilesApi["list"]>()
        .mockResolvedValueOnce(rootTree)
        .mockRejectedValueOnce(new Error("Workspace is resuming."))
        .mockImplementationOnce(async () => recovery),
      read: vi.fn(),
      save: vi.fn(),
    };
    const client = new QueryClient();
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    await React.act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <ThreadFilesPanel
            active
            changesTransport={createChangesTransport()}
            onOpenFile={vi.fn()}
            threadId={threadId}
            transport={transport}
          />
        </QueryClientProvider>,
      ),
    );
    await settle();

    await React.act(async () => {
      void client.refetchQueries({ queryKey: ["thread-files", threadId] });
    });
    await settle();
    expect(container.textContent).toContain("README.md");
    expect(container.textContent).toContain("Reconnecting…");
    expect(container.querySelector('[role="alert"]')).toBeNull();

    await React.act(async () => recover?.(rootTree));
    await vi.waitFor(() =>
      expect(container.textContent).not.toContain("Reconnecting…"),
    );
    await React.act(() => root.unmount());
  });

  it("keeps cached Files visible while a normal focus refresh is in flight", async () => {
    let refresh: ((tree: ThreadFileTreeData) => void) | undefined;
    const pendingRefresh = new Promise<ThreadFileTreeData>((resolve) => {
      refresh = resolve;
    });
    const transport: ThreadFilesApi = {
      list: vi
        .fn<ThreadFilesApi["list"]>()
        .mockResolvedValueOnce(rootTree)
        .mockImplementationOnce(async () => pendingRefresh),
      read: vi.fn(),
      save: vi.fn(),
    };
    const client = new QueryClient();
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    await React.act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <ThreadFilesPanel
            active
            changesTransport={createChangesTransport()}
            onOpenFile={vi.fn()}
            threadId={threadId}
            transport={transport}
          />
        </QueryClientProvider>,
      ),
    );
    await settle();

    await React.act(async () => {
      void client.refetchQueries({ queryKey: ["thread-files", threadId] });
    });
    await settle();

    expect(container.textContent).toContain("README.md");
    expect(container.textContent).toContain("Refreshing…");
    expect(container.textContent).not.toContain("Reconnecting…");

    await React.act(async () => refresh?.(rootTree));
    await vi.waitFor(() =>
      expect(container.textContent).not.toContain("Refreshing…"),
    );
    await React.act(() => root.unmount());
  });

  it("keeps a cached file visible while a recovery read is reconnecting", async () => {
    const filePath = "src/index.ts" as ThreadFilesPath;
    const file = {
      kind: "file" as const,
      path: filePath,
      editable: true as const,
      contentVersion: version,
      content: "export const cached = true;\n",
      sizeBytes: 28,
      language: "typescript",
      mediaType: "text/typescript",
    };
    let recover: ((value: typeof file) => void) | undefined;
    const recovery = new Promise<typeof file>((resolve) => {
      recover = resolve;
    });
    const transport: ThreadFilesApi = {
      list: vi.fn(),
      read: vi
        .fn<ThreadFilesApi["read"]>()
        .mockResolvedValueOnce(file)
        .mockRejectedValueOnce(new Error("Workspace is resuming."))
        .mockImplementationOnce(async () => recovery),
      save: vi.fn(),
    };
    const client = new QueryClient();
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    await React.act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <ThreadFilePane
            active
            onDirtyChange={vi.fn()}
            path={filePath}
            threadId={threadId}
            transport={transport}
          />
        </QueryClientProvider>,
      ),
    );
    await settle();
    await settle();

    await React.act(async () => {
      void client.refetchQueries({ queryKey: ["thread-files", threadId] });
    });
    await settle();
    expect(
      container.querySelector('[aria-label="File src/index.ts"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain("Reconnecting…");

    await React.act(async () => recover?.(file));
    await vi.waitFor(() =>
      expect(container.textContent).not.toContain("Reconnecting…"),
    );
    expect(
      container.querySelector('[aria-label="File src/index.ts"]'),
    ).not.toBeNull();
    await React.act(() => root.unmount());
  });

  it("keeps a paused Files wake in the loading state until it succeeds", async () => {
    let finishWake: ((tree: ThreadFileTreeData) => void) | undefined;
    const waking = new Promise<ThreadFileTreeData>((resolve) => {
      finishWake = resolve;
    });
    const transport: ThreadFilesApi = {
      list: vi.fn(async () => waking),
      read: vi.fn(),
      save: vi.fn(),
    };
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    await React.act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <ThreadDesktopLayout
            changes={<div>Changes</div>}
            files={
              <ThreadFilesPanel
                changesTransport={createChangesTransport()}
                onOpenFile={vi.fn()}
                threadId={threadId}
                transport={transport}
              />
            }
            main={<div>Agent</div>}
            rightPaneCollapsed={false}
          />
        </QueryClientProvider>,
      ),
    );

    await React.act(() =>
      container
        .querySelector<HTMLButtonElement>("#thread-workspace-tab-files")
        ?.click(),
    );

    expect(transport.list).toHaveBeenCalledOnce();
    expect(
      container.querySelector('[role="status"] .workspace-loading-glyph'),
    ).not.toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Waking workspace and loading files…",
    );
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).not.toContain(
      "Files are temporarily unavailable",
    );

    await React.act(() => finishWake?.(rootTree));
    await settle();
    expect(container.textContent).toContain("README.md");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await React.act(() => root.unmount());
  });

  it("surfaces a genuine Files activation failure after tab selection", async () => {
    const transport: ThreadFilesApi = {
      list: vi.fn(async () => {
        throw new Error("Workspace activation failed.");
      }),
      read: vi.fn(),
      save: vi.fn(),
    };
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    await React.act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <ThreadDesktopLayout
            changes={<div>Changes</div>}
            files={
              <ThreadFilesPanel
                changesTransport={createChangesTransport()}
                onOpenFile={vi.fn()}
                threadId={threadId}
                transport={transport}
              />
            }
            main={<div>Agent</div>}
            rightPaneCollapsed={false}
          />
        </QueryClientProvider>,
      ),
    );

    await React.act(() =>
      container
        .querySelector<HTMLButtonElement>("#thread-workspace-tab-files")
        ?.click(),
    );
    await settle();

    await vi.waitFor(() =>
      expect(container.querySelector('[role="alert"]')).not.toBeNull(),
    );
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Workspace activation failed.");
    expect(alert?.textContent).toContain("Retry");
    expect(container.querySelector(".dx-loading")).toBeNull();
    await React.act(() => root.unmount());
  });

  it("loads names for only the root and then each explicitly expanded directory", async () => {
    const transport: ThreadFilesApi = {
      list: vi.fn(async (_threadId, path) =>
        path === undefined ? rootTree : sourceTree,
      ),
      read: vi.fn(),
      save: vi.fn(),
    };
    const onOpenFile = vi.fn();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    await React.act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <ThreadFilesPanel
            changesTransport={createChangesTransport()}
            threadId={threadId}
            transport={transport}
            onOpenFile={onOpenFile}
          />
        </QueryClientProvider>,
      ),
    );
    await settle();
    expect(transport.list).toHaveBeenCalledTimes(1);
    expect(transport.list).toHaveBeenCalledWith(
      threadId,
      undefined,
      undefined,
      primaryWorktree,
      expect.anything(),
    );
    expect(transport.read).not.toHaveBeenCalled();

    const directory = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "src/",
    );
    await React.act(() =>
      directory?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    await settle();
    expect(transport.list).toHaveBeenCalledTimes(2);
    expect(transport.list).toHaveBeenLastCalledWith(
      threadId,
      "src",
      undefined,
      primaryWorktree,
      expect.anything(),
    );
    expect(transport.read).not.toHaveBeenCalled();

    const file = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "src/index.ts",
    );
    await React.act(() =>
      file?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(onOpenFile).toHaveBeenCalledWith({
      worktree: primaryWorktree,
      path: "src/index.ts",
    });
    expect(transport.read).not.toHaveBeenCalled();
    await React.act(() => root.unmount());
  });

  it("does not fetch file bytes until the opened file pane mounts", async () => {
    const filePath = "src/index.ts" as ThreadFilesPath;
    const transport: ThreadFilesApi = {
      list: vi.fn(),
      read: vi.fn(async () => ({
        kind: "file" as const,
        path: filePath,
        editable: true as const,
        contentVersion: version,
        content: "export const proof = true;\n",
        sizeBytes: 27,
        language: "typescript",
        mediaType: "text/typescript",
      })),
      save: vi.fn(),
    };
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    expect(transport.read).not.toHaveBeenCalled();
    await React.act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <ThreadFilePane
            threadId={threadId}
            path={filePath}
            transport={transport}
            onDirtyChange={vi.fn()}
          />
        </QueryClientProvider>,
      ),
    );
    await settle();
    await settle();
    expect(transport.read).toHaveBeenCalledTimes(1);
    expect(transport.read).toHaveBeenCalledWith(
      threadId,
      filePath,
      primaryWorktree,
      expect.anything(),
    );
    await React.act(() => root.unmount());
  });

  it("offers pagination independently for every expanded directory", async () => {
    const aCursor = "a-next" as ThreadFilesCursor;
    const bCursor = "b-next" as ThreadFilesCursor;
    const transport: ThreadFilesApi = {
      list: vi.fn(async (_threadId, path, cursor) => {
        if (path === undefined)
          return {
            ...rootTree,
            entries: [
              {
                path: "a" as ThreadFilesPath,
                name: "a",
                kind: "directory" as const,
              },
              {
                path: "b" as ThreadFilesPath,
                name: "b",
                kind: "directory" as const,
              },
            ],
          };
        return {
          kind: "tree" as const,
          path,
          version,
          entries: [],
          nextCursor:
            cursor === undefined
              ? path === "a"
                ? aCursor
                : bCursor
              : undefined,
        };
      }),
      read: vi.fn(),
      save: vi.fn(),
    };
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    await React.act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <ThreadFilesPanel
            changesTransport={createChangesTransport()}
            threadId={threadId}
            transport={transport}
            onOpenFile={vi.fn()}
          />
        </QueryClientProvider>,
      ),
    );
    await settle();
    for (const label of ["a/", "b/"]) {
      const directory = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === label,
      );
      await React.act(() =>
        directory?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
      );
      await settle();
    }

    const moreA = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "More in a",
    );
    const moreB = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "More in b",
    );
    expect(moreA).toBeDefined();
    expect(moreB).toBeDefined();
    await React.act(() => {
      moreA?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      moreB?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();
    expect(transport.list).toHaveBeenCalledWith(
      threadId,
      "a",
      aCursor,
      primaryWorktree,
      expect.anything(),
    );
    expect(transport.list).toHaveBeenCalledWith(
      threadId,
      "b",
      bCursor,
      primaryWorktree,
      expect.anything(),
    );
    await React.act(() => root.unmount());
  });

  it("uses live uncommitted changes and aggregates statuses onto folders", async () => {
    const transport: ThreadFilesApi = {
      list: vi.fn(async () => ({
        ...rootTree,
        entries: [
          "src",
          "src-old",
          "untracked",
          "mixed",
          "removed",
          "clean",
        ].map((path) => ({
          path: path as ThreadFilesPath,
          name: path,
          kind: "directory" as const,
        })),
      })),
      read: vi.fn(),
      save: vi.fn(),
    };
    const getChanges = vi.fn(async () =>
      changesData([
        {
          path: "src/deep/new.ts" as ThreadChangesPath,
          status: "added",
        },
        {
          path: "src/deep/other.ts" as ThreadChangesPath,
          status: "added",
        },
        {
          path: "src-old/index.ts" as ThreadChangesPath,
          status: "modified",
        },
        {
          path: "untracked/new.ts" as ThreadChangesPath,
          status: "untracked",
        },
        { path: "mixed/a.ts" as ThreadChangesPath, status: "added" },
        { path: "mixed/u.ts" as ThreadChangesPath, status: "untracked" },
        { path: "removed/old.ts" as ThreadChangesPath, status: "deleted" },
      ]),
    );
    const changesTransport = createChangesTransport(getChanges);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(
      changesKeys.range(threadId, { kind: "all" }),
      changesData([
        { path: "clean/committed.ts" as ThreadChangesPath, status: "added" },
      ]),
    );
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    await React.act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <ThreadFilesPanel
            changesTransport={changesTransport}
            onOpenFile={vi.fn()}
            threadId={threadId}
            transport={transport}
          />
        </QueryClientProvider>,
      ),
    );
    await settle();

    expect(getChanges).toHaveBeenCalledWith(
      threadId,
      { kind: "uncommitted" },
      expect.anything(),
    );
    const status = (path: string) =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === path)
        ?.getAttribute("data-git-status");
    expect(status("src/")).toBe("added");
    expect(status("src-old/")).toBe("modified");
    expect(status("untracked/")).toBe("untracked");
    expect(status("mixed/")).toBe("modified");
    expect(status("removed/")).toBe("deleted");
    expect(status("clean/")).toBeNull();
    await React.act(() => root.unmount());
  });

  it("suppresses badges from a stale changes capture", async () => {
    const transport: ThreadFilesApi = {
      list: vi.fn(async () => rootTree),
      read: vi.fn(),
      save: vi.fn(),
    };
    const changesTransport = createChangesTransport(async () =>
      changesData(
        [{ path: "src/index.ts" as ThreadChangesPath, status: "modified" }],
        "stale",
      ),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    await React.act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <ThreadFilesPanel
            changesTransport={changesTransport}
            onOpenFile={vi.fn()}
            threadId={threadId}
            transport={transport}
          />
        </QueryClientProvider>,
      ),
    );
    await settle();

    const directory = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "src/",
    );
    expect(directory?.getAttribute("data-git-status")).toBeNull();
    await React.act(() => root.unmount());
  });

  it("marks only the expanded directory as busy until its children load", async () => {
    let resolveChildren: ((tree: ThreadFileTreeData) => void) | undefined;
    const children = new Promise<ThreadFileTreeData>((resolve) => {
      resolveChildren = resolve;
    });
    const transport: ThreadFilesApi = {
      list: vi.fn(async (_threadId, path) =>
        path === undefined ? rootTree : children,
      ),
      read: vi.fn(),
      save: vi.fn(),
    };
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    await React.act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <ThreadFilesPanel
            changesTransport={createChangesTransport()}
            onOpenFile={vi.fn()}
            threadId={threadId}
            transport={transport}
          />
        </QueryClientProvider>,
      ),
    );
    await settle();
    const directory = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "src/",
    );
    await React.act(() =>
      directory?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );

    const tree = container.querySelector('[aria-label="Workspace files"]');
    expect(tree?.getAttribute("aria-busy")).toBe("true");
    expect(
      [...(tree?.attributes ?? [])].some((attribute) =>
        attribute.name.startsWith("data-loading-directory-"),
      ),
    ).toBe(true);
    expect(container.textContent).toContain("Loading src…");

    await React.act(async () => resolveChildren?.(sourceTree));
    await settle();
    expect(
      container
        .querySelector('[aria-label="Workspace files"]')
        ?.getAttribute("aria-busy"),
    ).toBe("false");
    expect(container.textContent).not.toContain("Loading src…");
    await React.act(() => root.unmount());
  });
});
