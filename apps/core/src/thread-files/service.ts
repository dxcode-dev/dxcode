import {
  type ThreadFileData,
  type ThreadFilesCursor,
  ThreadFilesPath,
  type ThreadFilesPath as ThreadFilesPathType,
  ThreadFilesWorktreeId,
  type ThreadFileTreeData,
  ThreadFileVersion,
  type ThreadFileVersion as ThreadFileVersionType,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { Schema } from "effect";
import type { DxdChangesRefresh } from "../execution/dxd/protocol.js";
import type { Bindings } from "../http/types.js";
import {
  DaemonUnavailable,
  requestThreadDaemon,
} from "../threads/daemon-client.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class ThreadFilesInvalid extends Schema.TaggedError<ThreadFilesInvalid>()(
  "ThreadFilesInvalid",
  {},
) {}
export class ThreadFilesMissing extends Schema.TaggedError<ThreadFilesMissing>()(
  "ThreadFilesMissing",
  {},
) {}
export class ThreadFilesConflict extends Schema.TaggedError<ThreadFilesConflict>()(
  "ThreadFilesConflict",
  {},
) {}
export class ThreadFilesUnavailable extends Schema.TaggedError<ThreadFilesUnavailable>()(
  "ThreadFilesUnavailable",
  {},
) {}

const base64UrlEncode = (value: unknown) => {
  const bytes = textEncoder.encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
};

const base64UrlDecode = (value: string): unknown => {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(
    normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="),
  );
  return JSON.parse(
    textDecoder.decode(Uint8Array.from(binary, (char) => char.charCodeAt(0))),
  );
};

const CursorPayloadSchema = Schema.Struct({
  path: Schema.NullOr(ThreadFilesPath),
  worktree: Schema.optional(ThreadFilesWorktreeId),
  version: ThreadFileVersion,
  index: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10_000 })),
});

const cursorPayload = (cursor: ThreadFilesCursor | undefined) => {
  if (cursor === undefined) return undefined;
  try {
    return Schema.decodeUnknownSync(CursorPayloadSchema)(
      base64UrlDecode(cursor),
    );
  } catch {
    throw new ThreadFilesConflict();
  }
};

const cursorFor = (payload: typeof CursorPayloadSchema.Type) =>
  base64UrlEncode(payload) as ThreadFilesCursor;

const pathFor = (parent: ThreadFilesPathType | undefined, name: string) => {
  try {
    return Schema.decodeUnknownSync(ThreadFilesPath)(
      parent === undefined ? name : `${parent}/${name}`,
    );
  } catch {
    throw new ThreadFilesInvalid();
  }
};

const languageFor = (path: string) => {
  const extension = path.split(".").at(-1)?.toLowerCase();
  switch (extension) {
    case "ts":
    case "tsx":
      return "typescript";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "javascript";
    case "md":
    case "mdx":
      return "markdown";
    case "json":
      return "json";
    case "css":
      return "css";
    case "html":
      return "html";
    case "py":
      return "python";
    case "sh":
      return "shell";
    default:
      return "text";
  }
};

const mediaTypeFor = (path: string) => {
  const language = languageFor(path);
  if (language === "markdown") return "text/markdown";
  if (language === "json") return "application/json";
  return `text/${language === "text" ? "plain" : language}`;
};

const throwDxdFailure = (result: {
  readonly kind: "invalid" | "missing" | "conflict" | "unavailable";
}): never => {
  switch (result.kind) {
    case "invalid":
      throw new ThreadFilesInvalid();
    case "missing":
      throw new ThreadFilesMissing();
    case "conflict":
      throw new ThreadFilesConflict();
    default:
      throw new ThreadFilesUnavailable();
  }
};

export const listThreadFilesThroughDaemon = async (
  bindings: Pick<Bindings, "THREAD_EXECUTION">,
  threadId: ThreadId,
  path: ThreadFilesPathType | undefined,
  cursor?: ThreadFilesCursor,
  worktree?: ThreadFilesWorktreeId,
): Promise<ThreadFileTreeData> => {
  const payload = cursorPayload(cursor);
  if (
    payload !== undefined &&
    (payload.path !== (path ?? null) ||
      (payload.worktree ?? "primary") !== (worktree ?? "primary"))
  )
    throw new ThreadFilesConflict();
  const operation = {
    operation: "files.list",
    ...(worktree === undefined ? {} : { worktree }),
    path: path ?? null,
    ...(payload === undefined
      ? {}
      : { cursor: { version: payload.version, index: payload.index } }),
  } as const;
  const result = await requestThreadDaemon(bindings, threadId, operation).catch(
    async (cause: unknown) => {
      if (!(cause instanceof DaemonUnavailable) || cause.outcome !== "known")
        throw new ThreadFilesUnavailable();
      await new Promise((resolve) => setTimeout(resolve, 500));
      return requestThreadDaemon(bindings, threadId, operation).catch(() => {
        throw new ThreadFilesUnavailable();
      });
    },
  );
  if (result.kind !== "tree") return throwDxdFailure(result);
  return {
    kind: "tree",
    ...(path === undefined ? {} : { path }),
    version: result.version,
    entries: result.entries.map((entry) => ({
      path: pathFor(path, entry.name),
      name: entry.name,
      kind: entry.kind,
      ...(entry.sizeBytes === undefined ? {} : { sizeBytes: entry.sizeBytes }),
    })),
    ...(result.nextIndex === undefined
      ? {}
      : {
          nextCursor: cursorFor({
            path: path ?? null,
            ...(worktree === undefined ? {} : { worktree }),
            version: result.version,
            index: result.nextIndex,
          }),
        }),
  };
};

export const readThreadFileThroughDaemon = async (
  bindings: Pick<Bindings, "THREAD_EXECUTION">,
  threadId: ThreadId,
  path: ThreadFilesPathType,
  worktree?: ThreadFilesWorktreeId,
): Promise<ThreadFileData> => {
  const result = await requestThreadDaemon(bindings, threadId, {
    operation: "files.read",
    ...(worktree === undefined ? {} : { worktree }),
    path,
  }).catch(() => {
    throw new ThreadFilesUnavailable();
  });
  const fields = {
    kind: "file" as const,
    path,
    language: languageFor(path),
    mediaType: mediaTypeFor(path),
  };
  if (result.kind === "editable")
    return {
      ...fields,
      editable: true,
      contentVersion: result.version,
      content: result.content,
      sizeBytes: result.sizeBytes,
    };
  if (result.kind === "readonly")
    return {
      ...fields,
      editable: false,
      readonlyReason: result.reason,
      content: result.content,
      sizeBytes: result.sizeBytes,
    };
  return throwDxdFailure(result);
};

export const saveThreadFileThroughDaemon = async (
  bindings: Pick<Bindings, "THREAD_EXECUTION">,
  threadId: ThreadId,
  path: ThreadFilesPathType,
  expectedVersion: ThreadFileVersionType,
  content: string,
  refresh?: DxdChangesRefresh,
  worktree?: ThreadFilesWorktreeId,
) => {
  const result = await requestThreadDaemon(bindings, threadId, {
    operation: "files.save",
    ...(worktree === undefined ? {} : { worktree }),
    path,
    expectedVersion,
    content,
    ...(refresh === undefined ? {} : { refresh }),
  }).catch(() => {
    throw new ThreadFilesUnavailable();
  });
  if (result.kind === "saved")
    return { kind: "saved" as const, contentVersion: result.version };
  return throwDxdFailure(result);
};
