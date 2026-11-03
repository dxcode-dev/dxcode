import {
  THREAD_FILES_MAX_UPLOAD_BYTES,
  THREAD_FILES_UPLOAD_CHUNK_BYTES,
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
import { decodeBase64Url, encodeBase64Url } from "../encoding/base64.js";
import type { DxdChangesRefresh } from "../execution/dxd/protocol.js";
import type { Bindings } from "../http/types.js";
import {
  DaemonUnavailable,
  FILES_ROOT_SNAPSHOT_HEADER,
  requestThreadDaemon,
  type ThreadDaemonRequestOptions,
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

const base64UrlEncode = (value: unknown) =>
  encodeBase64Url(textEncoder.encode(JSON.stringify(value)));

// The cursor pattern and payload schema reject anything malformed.
const base64UrlDecode = (value: string): unknown =>
  JSON.parse(textDecoder.decode(decodeBase64Url(value)));

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
  options?: ThreadDaemonRequestOptions,
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
  let snapshotAt: string | undefined;
  const observed: ThreadDaemonRequestOptions = {
    ...options,
    observe: (headers) => {
      snapshotAt = headers.get(FILES_ROOT_SNAPSHOT_HEADER) ?? undefined;
      options?.observe?.(headers);
    },
  };
  const request = () =>
    options === undefined
      ? requestThreadDaemon(bindings, threadId, operation)
      : requestThreadDaemon(bindings, threadId, operation, observed);
  const result = await request().catch(async (cause: unknown) => {
    if (!(cause instanceof DaemonUnavailable) || cause.outcome !== "known")
      throw new ThreadFilesUnavailable();
    await new Promise((resolve) => setTimeout(resolve, 500));
    return request().catch(() => {
      throw new ThreadFilesUnavailable();
    });
  });
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
    ...(snapshotAt === undefined ? {} : { snapshotAt }),
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

const writeResult = (result: { readonly kind: string }) => {
  if (result.kind === "changed") return { kind: "changed" as const };
  return throwDxdFailure(result as Parameters<typeof throwDxdFailure>[0]);
};

/** A Files tree write (not an upload) as one dxd request. */
export type ThreadFilesWrite =
  | {
      readonly action: "create";
      readonly path: ThreadFilesPathType;
      readonly kind: "file" | "directory";
    }
  | {
      readonly action: "move" | "copy";
      readonly from: ThreadFilesPathType;
      readonly to: ThreadFilesPathType;
    }
  | { readonly action: "delete"; readonly path: ThreadFilesPathType };

const writeOperation = (
  write: ThreadFilesWrite,
  refresh: DxdChangesRefresh | undefined,
  worktree: ThreadFilesWorktreeId | undefined,
) => {
  const common = {
    ...(worktree === undefined ? {} : { worktree }),
    ...(refresh === undefined ? {} : { refresh }),
  };
  switch (write.action) {
    case "create":
      return {
        operation: "files.create" as const,
        path: write.path,
        kind: write.kind,
        ...common,
      };
    case "move":
    case "copy":
      return {
        operation: `files.${write.action}` as const,
        from: write.from,
        to: write.to,
        ...common,
      };
    case "delete":
      return {
        operation: "files.delete" as const,
        path: write.path,
        ...common,
      };
  }
};

export const writeThreadFilesThroughDaemon = async (
  bindings: Pick<Bindings, "THREAD_EXECUTION">,
  threadId: ThreadId,
  write: ThreadFilesWrite,
  refresh?: DxdChangesRefresh,
  worktree?: ThreadFilesWorktreeId,
) => {
  const result = await requestThreadDaemon(
    bindings,
    threadId,
    writeOperation(write, refresh, worktree),
  ).catch(() => {
    throw new ThreadFilesUnavailable();
  });
  return writeResult(result);
};

const toBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
};

/**
 * Uploads a new file in order, one chunk per dxd request. The bytes collect
 * in a hidden temporary beside the destination; only the last chunk renames
 * it into place, and only it carries the Changes refresh.
 */
export const uploadThreadFileThroughDaemon = async (
  bindings: Pick<Bindings, "THREAD_EXECUTION">,
  threadId: ThreadId,
  path: ThreadFilesPathType,
  bytes: Uint8Array,
  refresh?: DxdChangesRefresh,
  worktree?: ThreadFilesWorktreeId,
) => {
  if (bytes.byteLength > THREAD_FILES_MAX_UPLOAD_BYTES)
    throw new ThreadFilesInvalid();
  const upload = [...crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  let offset = 0;
  do {
    const chunk = bytes.subarray(
      offset,
      offset + THREAD_FILES_UPLOAD_CHUNK_BYTES,
    );
    const last = offset + chunk.byteLength >= bytes.byteLength;
    const result = await requestThreadDaemon(bindings, threadId, {
      operation: "files.upload",
      ...(worktree === undefined ? {} : { worktree }),
      path,
      upload,
      offset,
      content: toBase64(chunk),
      last,
      ...(last && refresh !== undefined ? { refresh } : {}),
    }).catch(() => {
      throw new ThreadFilesUnavailable();
    });
    writeResult(result);
    offset += chunk.byteLength;
  } while (offset < bytes.byteLength);
  return { kind: "changed" as const };
};
