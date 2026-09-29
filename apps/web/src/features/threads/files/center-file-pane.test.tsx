// @vitest-environment happy-dom

import type {
  ThreadFilesPath,
  ThreadFilesWorktreeId,
  ThreadSandboxFilePath,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@pierre/diffs/react", () => ({
  File: ({
    file,
    selectedLines,
  }: {
    readonly file: { readonly contents: string };
    readonly selectedLines: { start: number; end: number } | null;
  }) => (
    <pre
      data-testid="pierre-file"
      data-selected={
        selectedLines === null
          ? undefined
          : `${selectedLines.start}-${selectedLines.end}`
      }
    >
      {file.contents}
    </pre>
  ),
}));

vi.mock("./files-panel.js", () => ({
  ThreadFilePane: ({
    path,
    reveal,
  }: {
    readonly path: string;
    readonly reveal?: { kind: string };
  }) => (
    <div
      data-testid="workspace-editor"
      data-path={path}
      data-reveal={reveal?.kind}
    />
  ),
}));

import { THREAD_SANDBOX_FILE_MAX_PREVIEW_BYTES } from "@dx/api";
import type { CenterFileTab } from "../thread-center-tabs.js";
import { CenterFilePane } from "./center-file-pane.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const threadId = "thr_00000000-0000-4000-8000-000000000243" as ThreadId;

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const serve = (
  files: Record<
    string,
    { readonly size: number; readonly type: string; readonly body?: string }
  >,
) => {
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://dx.test");
      const file = files[url.searchParams.get("path") ?? ""];
      if (file === undefined) return new Response(null, { status: 404 });
      const headers = {
        "content-length": String(file.size),
        "content-type": file.type,
      };
      return new Response(init?.method === "HEAD" ? null : (file.body ?? ""), {
        status: 200,
        headers,
      });
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

const render = async (file: CenterFileTab) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await React.act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <CenterFilePane
          active
          file={file}
          threadId={threadId}
          onDirtyChange={vi.fn()}
        />
      </QueryClientProvider>,
    ),
  );
  return { container, root };
};

const sandbox = (path: string): CenterFileTab => ({
  kind: "sandbox",
  path: path as ThreadSandboxFilePath,
  dirty: false,
});

describe("CenterFilePane", () => {
  it("renders a PNG from the sandbox stream", async () => {
    serve({ "/tmp/chart.png": { size: 10, type: "image/png" } });
    const { container, root } = await render(sandbox("/tmp/chart.png"));
    const image = await vi.waitFor(() => {
      const found = container.querySelector("img");
      if (found === null) throw new Error("image not rendered");
      return found;
    });
    expect(image.getAttribute("src")).toBe(
      `/v1/threads/${threadId}/files-sandbox?path=%2Ftmp%2Fchart.png`,
    );
    expect(image.getAttribute("alt")).toBe("/tmp/chart.png");
    await React.act(() => root.unmount());
  });

  it("plays a video in a player that fills the pane", async () => {
    serve({ "/home/user/demo.mp4": { size: 2048, type: "video/mp4" } });
    const { container, root } = await render(sandbox("/home/user/demo.mp4"));
    const video = await vi.waitFor(() => {
      const found = container.querySelector("video");
      if (found === null) throw new Error("video not rendered");
      return found;
    });
    expect(video.hasAttribute("controls")).toBe(true);
    expect(video.parentElement?.classList).toContain("thread-file-media-video");
    expect(video.getAttribute("src")).toContain("files-sandbox?path=");
    await React.act(() => root.unmount());
  });

  it("offers files above 100 MiB only as a download", async () => {
    serve({
      "/home/user/huge.mp4": {
        size: THREAD_SANDBOX_FILE_MAX_PREVIEW_BYTES + 1,
        type: "video/mp4",
      },
    });
    const { container, root } = await render(sandbox("/home/user/huge.mp4"));
    await vi.waitFor(() =>
      expect(container.textContent).toContain(
        "This file is too large to preview",
      ),
    );
    expect(container.querySelector("video")).toBeNull();
    expect(container.textContent).toContain("Download file");
    await React.act(() => root.unmount());
  });

  it("shows read-only sandbox text with the written chunk highlighted", async () => {
    serve({
      "/home/user/notes.md": {
        size: 18,
        type: "text/plain; charset=utf-8",
        body: "one\ntwo\nthree\n",
      },
    });
    const { container, root } = await render({
      ...sandbox("/home/user/notes.md"),
      reveal: { kind: "text", text: "two\nthree" },
      revealSequence: 1,
    });
    const code = await vi.waitFor(() => {
      const found = container.querySelector<HTMLElement>(
        '[data-testid="pierre-file"]',
      );
      if (found === null) throw new Error("text not rendered");
      return found;
    });
    expect(code.textContent).toBe("one\ntwo\nthree\n");
    expect(code.dataset.selected).toBe("2-3");
    expect(container.textContent).toContain("Read-only");
    await React.act(() => root.unmount());
  });

  it("offers binary sandbox files as a download", async () => {
    serve({
      "/home/user/tool": { size: 3, type: "application/octet-stream" },
    });
    const { container, root } = await render(sandbox("/home/user/tool"));
    await vi.waitFor(() =>
      expect(container.textContent).toContain(
        "Binary content cannot be displayed",
      ),
    );
    await React.act(() => root.unmount());
  });

  it("offers a download when binary bytes follow a text-looking prefix", async () => {
    serve({
      "/home/user/mixed.log": {
        size: 12,
        type: "text/plain; charset=utf-8",
        body: "hello\u0000world",
      },
    });
    const { container, root } = await render(sandbox("/home/user/mixed.log"));
    await vi.waitFor(() =>
      expect(container.textContent).toContain(
        "Binary content cannot be displayed",
      ),
    );
    expect(container.querySelector('[data-testid="pierre-file"]')).toBeNull();
    await React.act(() => root.unmount());
  });

  it("reports a missing sandbox file with a retry", async () => {
    serve({});
    const { container, root } = await render(sandbox("/home/user/gone.txt"));
    await vi.waitFor(() =>
      expect(container.textContent).toContain(
        "This file no longer exists in the sandbox.",
      ),
    );
    expect(container.textContent).toContain("Retry");
    await React.act(() => root.unmount());
  });

  it("streams repository images by absolute path and keeps text in the editor", async () => {
    serve({
      "/home/user/workspace/repo/docs/shot.png": {
        size: 10,
        type: "image/png",
      },
    });
    const image = await render({
      kind: "workspace",
      worktree: "primary" as ThreadFilesWorktreeId,
      path: "docs/shot.png" as ThreadFilesPath,
      dirty: false,
    });
    await vi.waitFor(() =>
      expect(image.container.querySelector("img")?.getAttribute("src")).toBe(
        `/v1/threads/${threadId}/files-sandbox?path=%2Fhome%2Fuser%2Fworkspace%2Frepo%2Fdocs%2Fshot.png`,
      ),
    );
    await React.act(() => image.root.unmount());

    const text = await render({
      kind: "workspace",
      worktree: "primary" as ThreadFilesWorktreeId,
      path: "src/app.ts" as ThreadFilesPath,
      dirty: false,
      reveal: { kind: "text", text: "x" },
    });
    const editor = text.container.querySelector<HTMLElement>(
      '[data-testid="workspace-editor"]',
    );
    expect(editor?.dataset.path).toBe("src/app.ts");
    expect(editor?.dataset.reveal).toBe("text");
    await React.act(() => text.root.unmount());
  });
});
