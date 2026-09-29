import {
  THREAD_SANDBOX_WORKSPACE_ROOT,
  ThreadFilesPath,
  type ThreadFilesWorktreeId,
  ThreadSandboxFilePath,
} from "@dx/api";
import { Option, Schema } from "effect";

const PRIMARY_WORKTREE = "primary" as ThreadFilesWorktreeId;

/** A 1-based, inclusive range of lines to highlight when a file opens. */
export interface FileLineRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Where an opened file lives. Repository files use the editable Files API;
 * every other sandbox file is read-only and streamed by absolute path.
 */
export type ThreadFileTarget =
  | {
      readonly kind: "workspace";
      readonly worktree: ThreadFilesWorktreeId;
      readonly worktreeLabel?: string;
      readonly path: ThreadFilesPath;
    }
  | { readonly kind: "sandbox"; readonly path: ThreadSandboxFilePath };

/** What to highlight once the file's content is known. */
export type FileReveal =
  | { readonly kind: "lines"; readonly lines: FileLineRange }
  /** The text an edit wrote; located in the current content. */
  | { readonly kind: "text"; readonly text: string };

export interface ResolvedFileLink {
  readonly target: ThreadFileTarget;
  readonly lines?: FileLineRange;
}

const hashLines = /^#L(\d+)(?:C\d+)?(?:-L?(\d+)(?:C\d+)?)?$/;
const rootFileLine = /^[\w-]+\.[\w.-]+:\d+(?::\d+)?(?:-\d+(?::\d+)?)?$/;
const suffixLines = /:(\d+)(?::\d+)?(?:-(\d+)(?::\d+)?)?$/;

const range = (
  first: string | undefined,
  last: string | undefined,
): FileLineRange | undefined => {
  const start = Number(first);
  if (!Number.isSafeInteger(start) || start < 1) return undefined;
  const end = last === undefined ? start : Number(last);
  return Number.isSafeInteger(end) && end >= start
    ? { start, end }
    : { start, end: start };
};

/** Map an absolute guest path to its repository or sandbox location. */
export const fileTargetForAbsolutePath = (
  absolute: string,
): ThreadFileTarget | undefined => {
  const root = `${THREAD_SANDBOX_WORKSPACE_ROOT}/`;
  if (absolute.startsWith(root)) {
    const path = Schema.decodeUnknownOption(ThreadFilesPath)(
      absolute.slice(root.length),
    );
    if (Option.isSome(path))
      return {
        kind: "workspace",
        worktree: PRIMARY_WORKTREE,
        path: path.value,
      };
  }
  const path = Schema.decodeUnknownOption(ThreadSandboxFilePath)(absolute);
  return Option.isSome(path)
    ? { kind: "sandbox", path: path.value }
    : undefined;
};

/** The absolute guest path of a target, when one is known. */
export const absolutePathFor = (
  target: ThreadFileTarget,
): ThreadSandboxFilePath | undefined => {
  if (target.kind === "sandbox") return target.path;
  // Linked worktrees live at paths the browser is never told.
  if (target.worktree !== PRIMARY_WORKTREE) return undefined;
  return Schema.decodeUnknownOption(ThreadSandboxFilePath)(
    `${THREAD_SANDBOX_WORKSPACE_ROOT}/${target.path}`,
  ).pipe(Option.getOrUndefined);
};

/**
 * Resolve a Markdown href the agent wrote to a file in the Thread sandbox.
 * Accepts `file:///abs`, `/abs`, and repository-relative paths, each with an
 * optional `#L12-L15` or `:12-15` line anchor. External URLs, in-page anchors,
 * and anything outside the Files contracts resolve to `undefined`.
 */
export const resolveTranscriptFileLink = (
  href: string,
): ResolvedFileLink | undefined => {
  const value = href.trim();
  if (value.length === 0 || value.startsWith("#") || value.startsWith("//"))
    return undefined;
  let pathname: string;
  let hash = "";
  try {
    // `README.md:12` is a root-level file and line, not a URL scheme.
    if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !rootFileLine.test(value)) {
      const url = new URL(value);
      if (url.protocol !== "file:" || url.host !== "" || url.search !== "")
        return undefined;
      pathname = url.pathname;
      hash = url.hash;
    } else {
      // Resolve relative paths against the repository and normalize `.`/`..`.
      const base = `file://${THREAD_SANDBOX_WORKSPACE_ROOT}/`;
      // A leading `./` stops the URL parser reading `README.md:` as a scheme.
      const url = new URL(
        rootFileLine.test(value) ? `./${value}` : value,
        base,
      );
      if (url.search !== "") return undefined;
      pathname = url.pathname;
      hash = url.hash;
    }
    pathname = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  let lines: FileLineRange | undefined;
  const fromHash = hashLines.exec(hash);
  if (fromHash !== null) lines = range(fromHash[1], fromHash[2]);
  else if (hash !== "") return undefined;
  if (lines === undefined) {
    const fromSuffix = suffixLines.exec(pathname);
    if (fromSuffix !== null) {
      lines = range(fromSuffix[1], fromSuffix[2]);
      pathname = pathname.slice(0, fromSuffix.index);
    }
  }
  const target = fileTargetForAbsolutePath(pathname);
  if (target === undefined) return undefined;
  return lines === undefined ? { target } : { target, lines };
};

/** Locate the lines an edit wrote in the file's current content. */
export const linesForText = (
  content: string,
  text: string,
): FileLineRange | undefined => {
  if (text.length === 0) return undefined;
  const index = content.indexOf(text);
  if (index < 0) return undefined;
  const start = content.slice(0, index).split("\n").length;
  const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
  return { start, end: start + trimmed.split("\n").length - 1 };
};

export const resolveReveal = (
  content: string,
  reveal: FileReveal | undefined,
): FileLineRange | undefined => {
  if (reveal === undefined) return undefined;
  if (reveal.kind === "lines") return reveal.lines;
  return linesForText(content, reveal.text);
};

/** Stable identity of an open center tab. */
export const fileTargetKey = (target: ThreadFileTarget) =>
  target.kind === "sandbox"
    ? `sandbox:${target.path}`
    : `${target.worktree}:${target.path}`;

/** Same-origin URL that streams a sandbox file, optionally as a download. */
export const sandboxFileUrl = (
  threadId: string,
  path: ThreadSandboxFilePath,
  download = false,
) =>
  `/v1/threads/${encodeURIComponent(threadId)}/files-sandbox?${new URLSearchParams(
    download ? { path, download: "1" } : { path },
  )}`;

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "bmp",
  "ico",
  "svg",
]);
const VIDEO_EXTENSIONS = new Set(["mp4", "m4v", "webm", "mov", "ogv"]);

export const fileMediaKind = (path: string): "image" | "video" | undefined => {
  const extension = path.split("/").at(-1)?.split(".").at(-1)?.toLowerCase();
  if (extension === undefined) return undefined;
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (VIDEO_EXTENSIONS.has(extension)) return "video";
  return undefined;
};
