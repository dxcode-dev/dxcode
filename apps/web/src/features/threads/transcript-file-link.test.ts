import { describe, expect, it } from "vitest";
import {
  absolutePathFor,
  linesForText,
  resolveTranscriptFileLink,
  sandboxFileUrl,
} from "./transcript-file-link.js";

describe("resolveTranscriptFileLink", () => {
  it("resolves repository files with encoded names and line anchors", () => {
    expect(
      resolveTranscriptFileLink(
        "file:///home/user/workspace/repo/docs/hello%20world.md#L12-L15",
      ),
    ).toEqual({
      target: {
        kind: "workspace",
        worktree: "primary",
        path: "docs/hello world.md",
      },
      lines: { start: 12, end: 15 },
    });
  });

  it.each([
    ["apps/web/src/main.tsx", "apps/web/src/main.tsx", undefined],
    ["./README.md", "README.md", undefined],
    [
      "/home/user/workspace/repo/src/a.ts:42",
      "src/a.ts",
      { start: 42, end: 42 },
    ],
    ["src/a.ts:10-20", "src/a.ts", { start: 10, end: 20 }],
    ["src/a.ts:7:3", "src/a.ts", { start: 7, end: 7 }],
    ["src/a.ts#L3", "src/a.ts", { start: 3, end: 3 }],
    ["README.md:12", "README.md", { start: 12, end: 12 }],
    ["package.json:3-5", "package.json", { start: 3, end: 5 }],
  ])("opens repository-relative link %j", (href, path, lines) =>
    expect(resolveTranscriptFileLink(href)).toEqual({
      target: { kind: "workspace", worktree: "primary", path },
      ...(lines === undefined ? {} : { lines }),
    }),
  );

  it.each([
    ["/home/user/notes/todo.md", "/home/user/notes/todo.md"],
    ["file:///tmp/render.png", "/tmp/render.png"],
    ["../other/output.mp4", "/home/user/workspace/other/output.mp4"],
    ["/etc/passwd", "/etc/passwd"],
  ])("opens sandbox file %j outside the repository", (href, path) =>
    expect(resolveTranscriptFileLink(href)).toEqual({
      target: { kind: "sandbox", path },
    }),
  );

  it.each([
    "https://example.com/file.ts",
    "mailto:someone@example.com",
    "javascript:alert(1)",
    "#section",
    "//example.com/a.ts",
    "file://host/home/user/workspace/repo/a",
    "file:///home/user/workspace/repo/.git/config",
    "/home/user/.local/state/dxd/config.json",
    "/proc/self/environ",
    "src/a.ts?raw=1",
    "src/a.ts#section",
    "/home/user/workspace/repo/a%00b",
    "",
  ])("leaves %j as a non-file link", (href) =>
    expect(resolveTranscriptFileLink(href)).toBeUndefined(),
  );
});

describe("absolutePathFor", () => {
  it("knows the primary checkout and sandbox paths but not linked worktrees", () => {
    const repo = resolveTranscriptFileLink("src/a.ts");
    expect(repo && absolutePathFor(repo.target)).toBe(
      "/home/user/workspace/repo/src/a.ts",
    );
    const sandbox = resolveTranscriptFileLink("/tmp/a.png");
    expect(sandbox && absolutePathFor(sandbox.target)).toBe("/tmp/a.png");
    expect(
      repo &&
        repo.target.kind === "workspace" &&
        absolutePathFor({
          ...repo.target,
          worktree: "wt_0123456789abcdef" as typeof repo.target.worktree,
        }),
    ).toBeUndefined();
  });
});

describe("linesForText", () => {
  it("locates the written text as 1-based inclusive lines", () => {
    const content = "one\ntwo\nthree\nfour\n";
    expect(linesForText(content, "two\nthree")).toEqual({ start: 2, end: 3 });
    expect(linesForText(content, "four\n")).toEqual({ start: 4, end: 4 });
    expect(linesForText(content, "absent")).toBeUndefined();
    expect(linesForText(content, "")).toBeUndefined();
  });
});

describe("sandboxFileUrl", () => {
  it("builds the same-origin streaming and download URLs", () => {
    const path = "/tmp/a b.png" as Parameters<typeof sandboxFileUrl>[1];
    expect(sandboxFileUrl("thr_1", path)).toBe(
      "/v1/threads/thr_1/files-sandbox?path=%2Ftmp%2Fa+b.png",
    );
    expect(sandboxFileUrl("thr_1", path, true)).toBe(
      "/v1/threads/thr_1/files-sandbox?path=%2Ftmp%2Fa+b.png&download=1",
    );
  });
});
