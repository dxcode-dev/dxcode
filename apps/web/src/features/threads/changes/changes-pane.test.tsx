// @vitest-environment happy-dom

import type {
  ThreadChangesCaptureId,
  ThreadChangesCommitSha,
  ThreadChangesData,
  ThreadChangesDiffData,
  ThreadChangesPath,
  ThreadChangesRange,
  ThreadChangesWorktreeId,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const highlighter = vi.hoisted(() => ({ shouldFail: false }));

vi.mock("@pierre/diffs", () => ({
  getFiletypeFromFileName: () => "typescript",
  preloadHighlighter: async () => {
    if (highlighter.shouldFail) throw new Error("highlighter unavailable");
  },
  parsePatchFiles: () => [{ files: [{ marker: "parsed-diff" }] }],
}));
vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({
    options,
  }: {
    options: { diffStyle: string; overflow: string };
  }) => (
    <div
      data-testid="code-view"
      data-style={options.diffStyle}
      data-overflow={options.overflow}
    >
      1 diff
    </div>
  ),
}));

import type { ChangesTransport } from "./changes-api.js";
import { ChangesPane, REVIEW_CHANGES_PROMPT } from "./changes-pane.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const threadId = "thr_00000000-0000-4000-8000-000000000249" as ThreadId;
const captureId =
  "chg_00000000-0000-4000-8000-000000000249" as ThreadChangesCaptureId;
const baseline = "a".repeat(40) as ThreadChangesCommitSha;
const head = "b".repeat(40) as ThreadChangesCommitSha;
const path = "src/example.ts" as ThreadChangesPath;

const dataFor = (
  range: ThreadChangesRange,
  selectedCaptureId = captureId,
): ThreadChangesData => ({
  kind: "changes",
  captureId: selectedCaptureId,
  freshness: "complete",
  capturedAt: "2026-08-29T12:00:00.000Z",
  range,
  truncated: false,
  baseline,
  head,
  branch: "codex/thread-changes",
  upstreamLabel: "origin/main",
  ahead: 2,
  summary: { additions: 4, deletions: 1, files: 1 },
  files: [
    {
      path,
      status: "modified",
      additions: 4,
      deletions: 1,
      binary: false,
      truncated: false,
    },
  ],
  commits: [{ sha: head, shortSha: head.slice(0, 7), subject: "Change UI" }],
});

const settle = () =>
  React.act(() => new Promise((resolve) => setTimeout(resolve, 0)));

const click = (element: Element | null) =>
  React.act(() =>
    element?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
  );

const buttonNamed = (container: Element, name: string) =>
  [...container.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === name,
  ) ?? null;

afterEach(() => {
  highlighter.shouldFail = false;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("Changes pane", () => {
  it("renders focused loading, error, and empty states", async () => {
    let resolveChanges: ((value: ThreadChangesData) => void) | undefined;
    const getChanges = vi
      .fn<ChangesTransport["getChanges"]>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveChanges = resolve;
          }),
      );
    const transport: ChangesTransport = {
      getChanges,
      getDiff: vi.fn(),
      push: vi.fn(),
    };
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    await React.act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <ChangesPane
            threadId={threadId}
            transport={transport}
            onReviewPrompt={() => undefined}
          />
        </QueryClientProvider>,
      ),
    );
    expect(container.textContent).toContain("Loading changes…");
    expect(
      container
        .querySelector('[aria-label="Refresh changes"]')
        ?.hasAttribute("disabled"),
    ).toBe(true);

    getChanges.mockRejectedValueOnce(new Error("Capture service unavailable"));
    await React.act(() => {
      resolveChanges?.({
        ...dataFor({ kind: "all" }),
        files: [],
        commits: [],
        ahead: 0,
        summary: { additions: 0, deletions: 0, files: 0 },
      });
      return Promise.resolve();
    });
    await settle();
    expect(container.querySelector(".changes-empty")?.textContent).toBe(
      "No Changes",
    );
    expect(container.querySelector(".changes-view-controls")).toBeNull();
    expect(container.querySelector(".changes-footer")).toBeNull();

    await click(container.querySelector('[aria-label="Refresh changes"]'));
    await settle();
    expect(container.textContent).toContain("Capture service unavailable");
    expect(buttonNamed(container, "Retry")).not.toBeNull();
    await React.act(() => root.unmount());
    client.clear();
  });

  it("groups added, deleted, and modified files with binary handling", async () => {
    const files: ThreadChangesData["files"] = [
      {
        path: "src/modified.ts" as ThreadChangesPath,
        status: "modified",
        additions: 3,
        deletions: 2,
        binary: false,
        truncated: false,
      },
      {
        path: "assets/logo.png" as ThreadChangesPath,
        status: "added",
        additions: 0,
        deletions: 0,
        binary: true,
        truncated: false,
      },
      {
        path: "docs/old.md" as ThreadChangesPath,
        status: "deleted",
        additions: 0,
        deletions: 8,
        binary: false,
        truncated: false,
      },
    ];
    const transport: ChangesTransport = {
      getChanges: vi.fn(async (_id, range) => ({
        ...dataFor(range),
        files,
        summary: { additions: 3, deletions: 10, files: 3 },
      })),
      getDiff: vi.fn(),
      push: vi.fn(),
    };
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    await React.act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <ChangesPane
            threadId={threadId}
            projectName="dx"
            transport={transport}
            onReviewPrompt={() => undefined}
          />
        </QueryClientProvider>,
      ),
    );
    await settle();
    expect(
      [...container.querySelectorAll(".changes-file-trigger")].map((row) =>
        row.getAttribute("title"),
      ),
    ).toEqual(["assets/logo.png", "docs/old.md", "src/modified.ts"]);
    expect(container.querySelectorAll('b[data-status="added"]')).toHaveLength(
      1,
    );
    expect(container.querySelectorAll('b[data-status="deleted"]')).toHaveLength(
      1,
    );
    expect(
      container.querySelectorAll('b[data-status="modified"]'),
    ).toHaveLength(1);
    await click(
      container.querySelector('.changes-file-trigger[title="assets/logo.png"]'),
    );
    expect(container.textContent).toContain(
      "Binary file preview is unavailable.",
    );
    expect(transport.getDiff).not.toHaveBeenCalled();
    await React.act(() => root.unmount());
    client.clear();
  });

  it("groups duplicate paths by worktree and collapses each group independently", async () => {
    const linkedId = "wt_0123456789abcdef" as ThreadChangesWorktreeId;
    const primaryId = "primary" as ThreadChangesWorktreeId;
    const baseFile = dataFor({ kind: "all" }).files[0];
    if (baseFile === undefined) throw new Error("Fixture file is missing.");
    const files: ThreadChangesData["files"] = [
      { ...baseFile, worktree: primaryId },
      {
        ...baseFile,
        worktree: linkedId,
        additions: 2,
      },
    ];
    const linkedFile = files[1];
    if (linkedFile === undefined) throw new Error("Fixture file is missing.");
    const transport: ChangesTransport = {
      getChanges: vi.fn(async (_id, range) => ({
        ...dataFor(range),
        files,
        summary: { additions: 6, deletions: 2, files: 2 },
        worktrees: [
          { id: primaryId, name: "dx", head, branch: "main" },
          { id: linkedId, name: "agent-worktree", head, branch: "agent" },
        ],
      })),
      getDiff: vi.fn(async (_id, _path, range, requestedCaptureId) => ({
        kind: "diff" as const,
        captureId: requestedCaptureId,
        freshness: "complete" as const,
        capturedAt: "2026-08-29T12:00:00.000Z",
        range,
        file: linkedFile,
        patch: "@@ -1 +1 @@\n-old\n+linked\n",
      })),
      push: vi.fn(),
    };
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    await React.act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <ChangesPane
            threadId={threadId}
            projectName="dx"
            transport={transport}
            onReviewPrompt={() => undefined}
          />
        </QueryClientProvider>,
      ),
    );
    await settle();

    const primary = container.querySelector('[aria-label="dx changes"]');
    const linked = container.querySelector(
      '[aria-label="agent-worktree changes"]',
    );
    expect(primary?.querySelectorAll(".changes-file-trigger")).toHaveLength(1);
    expect(linked?.querySelectorAll(".changes-file-trigger")).toHaveLength(1);
    await click(linked?.querySelector(".changes-worktree-trigger") ?? null);
    expect(linked?.querySelectorAll(".changes-file-trigger")).toHaveLength(0);
    expect(primary?.querySelectorAll(".changes-file-trigger")).toHaveLength(1);
    await click(linked?.querySelector(".changes-worktree-trigger") ?? null);
    await click(linked?.querySelector(".changes-file-trigger") ?? null);
    await settle();
    expect(transport.getDiff).toHaveBeenCalledWith(
      threadId,
      path,
      { kind: "all" },
      captureId,
      expect.anything(),
      linkedId,
    );
    await React.act(() => root.unmount());
    client.clear();
  });

  it("opens the selected changed file through the navigation callback", async () => {
    const onOpenFile = vi.fn();
    const transport: ChangesTransport = {
      getChanges: vi.fn(async (_id, range) => dataFor(range)),
      getDiff: vi.fn(),
      push: vi.fn(),
    };
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    await React.act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <ChangesPane
            threadId={threadId}
            transport={transport}
            onReviewPrompt={() => undefined}
            onOpenFile={onOpenFile}
          />
        </QueryClientProvider>,
      ),
    );
    await settle();
    await click(
      container.querySelector('[aria-label="Actions for src/example.ts"]'),
    );
    await settle();
    await click(
      [...document.querySelectorAll('[role="menuitem"]')].find(
        (item) => item.textContent?.trim() === "Open File",
      ) ?? null,
    );
    expect(onOpenFile).toHaveBeenCalledWith("primary", path);
    await React.act(() => root.unmount());
    client.clear();
  });

  it("does not open deleted files from the current workspace", async () => {
    const onOpenFile = vi.fn();
    const deletedPath = "src/deleted.ts" as ThreadChangesPath;
    const transport: ChangesTransport = {
      getChanges: vi.fn<ChangesTransport["getChanges"]>(async (_id, range) => ({
        ...dataFor(range),
        files: [
          {
            path: deletedPath,
            status: "deleted",
            additions: 0,
            deletions: 4,
            binary: false,
            truncated: false,
          },
        ],
      })),
      getDiff: vi.fn(),
      push: vi.fn(),
    };
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    await React.act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <ChangesPane
            threadId={threadId}
            transport={transport}
            onReviewPrompt={() => undefined}
            onOpenFile={onOpenFile}
          />
        </QueryClientProvider>,
      ),
    );
    await settle();
    await click(
      container.querySelector(`[aria-label="Actions for ${deletedPath}"]`),
    );
    await settle();
    const openFile = [...document.querySelectorAll('[role="menuitem"]')].find(
      (item) => item.textContent?.trim() === "Open File",
    );
    expect(openFile?.getAttribute("aria-disabled")).toBe("true");
    await click(openFile ?? null);
    expect(onOpenFile).not.toHaveBeenCalled();
    await React.act(() => root.unmount());
    client.clear();
  });

  it("reads durable captures, expands a diff, selects a range, reviews, and pushes", async () => {
    let displayedCaptureId = captureId;
    let notifyChanges: (() => void) | undefined;
    const unsubscribe = vi.fn();
    const transport: ChangesTransport = {
      getChanges: vi.fn<ChangesTransport["getChanges"]>(async (_id, range) =>
        dataFor(range, displayedCaptureId),
      ),
      getDiff: vi.fn<ChangesTransport["getDiff"]>(
        async (_id, requestedPath, range, requestedCaptureId) => {
          const file = dataFor(range).files[0];
          if (file === undefined) throw new Error("Fixture file is missing.");
          return {
            kind: "diff",
            captureId: requestedCaptureId,
            freshness: "complete",
            capturedAt: "2026-08-29T12:00:00.000Z",
            range,
            file,
            patch:
              `diff --git a/${requestedPath} b/${requestedPath}\n` +
              `--- a/${requestedPath}\n+++ b/${requestedPath}\n` +
              "@@ -1 +1 @@\n-old\n+new\n",
          } satisfies ThreadChangesDiffData;
        },
      ),
      push: vi.fn<ChangesTransport["push"]>(async () => ({
        kind: "pushed",
        status: "pushed",
        sha: head,
      })),
      subscribe: vi.fn((_id, onChangesUpdated) => {
        notifyChanges = onChangesUpdated;
        return unsubscribe;
      }),
    };
    const onReviewPrompt = vi.fn();
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await React.act(() =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <ChangesPane
            threadId={threadId}
            transport={transport}
            onReviewPrompt={onReviewPrompt}
          />
        </QueryClientProvider>,
      ),
    );
    await settle();

    expect(container.textContent).toContain("ALL CHANGES");
    expect(container.textContent).toContain("example.ts");
    expect(container.textContent).toContain("+4");
    expect(transport.getChanges).toHaveBeenCalledWith(
      threadId,
      {
        kind: "all",
      },
      expect.anything(),
    );

    await click(container.querySelector(".changes-file-trigger"));
    await settle();
    expect(transport.getDiff).toHaveBeenCalledWith(
      threadId,
      path,
      {
        kind: "all",
      },
      captureId,
      expect.anything(),
      "primary",
    );
    expect(
      container.querySelector('[data-testid="code-view"]')?.textContent,
    ).toBe("1 diff");
    await click(container.querySelector('[aria-label="Wrap lines"]'));
    await click(container.querySelector('[aria-label="Side-by-side diff"]'));
    expect(
      container
        .querySelector('[data-testid="code-view"]')
        ?.getAttribute("data-overflow"),
    ).toBe("wrap");
    expect(
      container
        .querySelector('[data-testid="code-view"]')
        ?.getAttribute("data-style"),
    ).toBe("split");
    expect(transport.getDiff).toHaveBeenCalledTimes(1);
    await click(container.querySelector('[aria-label="Collapse all files"]'));
    expect(container.querySelector('[data-testid="code-view"]')).toBeNull();
    await click(container.querySelector(".changes-file-trigger"));
    await settle();
    expect(transport.getDiff).toHaveBeenCalledTimes(1);

    displayedCaptureId =
      "chg_00000000-0000-4000-8000-000000000250" as ThreadChangesCaptureId;
    notifyChanges?.();
    await vi.waitFor(async () => {
      await settle();
      expect(transport.getDiff).toHaveBeenLastCalledWith(
        threadId,
        path,
        { kind: "all" },
        displayedCaptureId,
        expect.anything(),
        "primary",
      );
    });

    await click(buttonNamed(container, "Review"));
    expect(onReviewPrompt).toHaveBeenCalledWith(REVIEW_CHANGES_PROMPT);

    await click(container.querySelector('[aria-label="Choose Changes range"]'));
    const rangeMenu = container.querySelector('[role="menu"]');
    rangeMenu?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await settle();
    expect(container.querySelector('[role="menu"]')).toBeNull();
    await click(container.querySelector('[aria-label="Choose Changes range"]'));
    await click(buttonNamed(container, "Uncommitted"));
    await settle();
    expect(transport.getChanges).toHaveBeenLastCalledWith(
      threadId,
      {
        kind: "uncommitted",
      },
      expect.anything(),
    );

    await click(buttonNamed(container, "Push"));
    const pushConfirmation = container.querySelector("dialog[open]");
    expect(pushConfirmation).not.toBeNull();
    expect(pushConfirmation?.getAttribute("aria-labelledby")).toBe(
      "changes-push-confirmation-title",
    );
    await click(buttonNamed(container, "Confirm push"));
    await settle();
    expect(transport.push).toHaveBeenCalledWith(threadId, {
      expectedCaptureId: displayedCaptureId,
      idempotencyKey: expect.stringMatching(/^push-/),
    });
    expect(transport.subscribe).toHaveBeenCalledTimes(1);
    expect(unsubscribe).not.toHaveBeenCalled();
    await React.act(() => root.unmount());
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("shows stale captures but disables push", async () => {
    const transport: ChangesTransport = {
      getChanges: vi.fn<ChangesTransport["getChanges"]>(async (_id, range) => ({
        ...dataFor(range),
        freshness: "stale",
        dirtySince: "2026-08-29T12:01:00.000Z",
      })),
      getDiff: vi.fn<ChangesTransport["getDiff"]>(),
      push: vi.fn<ChangesTransport["push"]>(),
    };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await React.act(() =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <ChangesPane
            threadId={threadId}
            transport={transport}
            onReviewPrompt={() => undefined}
          />
        </QueryClientProvider>,
      ),
    );
    await settle();

    expect(container.textContent).toContain("Showing last saved capture");
    expect(buttonNamed(container, "Push")?.hasAttribute("disabled")).toBe(true);
    await React.act(() => root.unmount());
  });

  it("rejects a diff from another capture and refreshes the list", async () => {
    const otherCaptureId =
      "chg_00000000-0000-4000-8000-000000000251" as ThreadChangesCaptureId;
    const transport: ChangesTransport = {
      getChanges: vi.fn<ChangesTransport["getChanges"]>(async (_id, range) =>
        dataFor(range),
      ),
      getDiff: vi.fn<ChangesTransport["getDiff"]>(async (_id, _path, range) => {
        const file = dataFor(range).files[0];
        if (file === undefined) throw new Error("Fixture file is missing.");
        return {
          kind: "diff",
          captureId: otherCaptureId,
          freshness: "complete",
          capturedAt: "2026-08-29T12:00:00.000Z",
          range,
          file,
          patch: "+wrong capture\n",
        };
      }),
      push: vi.fn<ChangesTransport["push"]>(),
    };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await React.act(() =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <ChangesPane
            threadId={threadId}
            transport={transport}
            onReviewPrompt={() => undefined}
          />
        </QueryClientProvider>,
      ),
    );
    await settle();
    await click(container.querySelector(".changes-file-trigger"));
    await settle();

    expect(container.textContent).toContain(
      "This diff belongs to a different Changes capture.",
    );
    expect(container.querySelector('[data-testid="code-view"]')).toBeNull();
    expect(transport.getChanges).toHaveBeenCalledTimes(2);
    await React.act(() => root.unmount());
  });
});
