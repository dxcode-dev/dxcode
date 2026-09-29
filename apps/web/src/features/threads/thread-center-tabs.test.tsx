// @vitest-environment happy-dom

import type {
  ThreadFilesPath,
  ThreadFilesWorktreeId,
  ThreadSandboxFilePath,
} from "@dx/api";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadCenterTabs } from "./thread-center-tabs.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("Thread center file tabs", () => {
  it("requires an explicit decision before closing a dirty file", async () => {
    const path = "src/index.ts" as ThreadFilesPath;
    const file = {
      kind: "workspace" as const,
      worktree: "primary" as ThreadFilesWorktreeId,
      path,
      dirty: true,
    };
    const onClose = vi.fn();
    const confirm = vi.fn(() => false);
    Object.defineProperty(window, "confirm", {
      configurable: true,
      value: confirm,
    });
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    await React.act(() =>
      root.render(
        <ThreadCenterTabs
          activeFile={`primary:${path}`}
          files={[file]}
          onClose={onClose}
          onSelect={vi.fn()}
        />,
      ),
    );
    const close = container.querySelector(`[aria-label="Close ${path}"]`);
    await React.act(() =>
      close?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(confirm).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    await React.act(() =>
      close?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(onClose).toHaveBeenCalledWith(file);
    await React.act(() => root.unmount());
  });

  it("distinguishes the same path opened from different worktrees", async () => {
    const path = "src/index.ts" as ThreadFilesPath;
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    await React.act(() =>
      root.render(
        <ThreadCenterTabs
          files={[
            {
              kind: "workspace",
              worktree: "primary" as ThreadFilesWorktreeId,
              path,
              worktreeLabel: "dx",
              dirty: false,
            },
            {
              kind: "workspace",
              worktree: "wt_0123456789abcdef" as ThreadFilesWorktreeId,
              path,
              worktreeLabel: "feature-worktree",
              dirty: false,
            },
          ]}
          onClose={vi.fn()}
          onSelect={vi.fn()}
        />,
      ),
    );

    expect(
      [...container.querySelectorAll('[role="tab"]')].map((tab) =>
        tab.getAttribute("aria-label"),
      ),
    ).toContain("index.ts — dx");
    expect(container.textContent).toContain("feature-worktree");
    await React.act(() => root.unmount());
  });

  it("labels read-only sandbox files and keys them by absolute path", async () => {
    const path = "/home/user/notes/todo.md" as ThreadSandboxFilePath;
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    const onSelect = vi.fn();
    await React.act(() =>
      root.render(
        <ThreadCenterTabs
          files={[{ kind: "sandbox", path, dirty: false }]}
          onClose={vi.fn()}
          onSelect={onSelect}
        />,
      ),
    );
    const tab = container.querySelector<HTMLButtonElement>(
      '[aria-label="todo.md — Sandbox"]',
    );
    expect(tab?.title).toBe(path);
    await React.act(() => tab?.click());
    expect(onSelect).toHaveBeenCalledWith(`sandbox:${path}`);
    await React.act(() => root.unmount());
  });
});
