import {
  THREAD_SANDBOX_FILE_MAX_CHUNK_BYTES,
  THREAD_SANDBOX_FILE_MAX_PREVIEW_BYTES,
  ThreadFilesConflictResponseSchema,
  ThreadFilesEntryNotFoundResponseSchema,
  ThreadFilesInvalidRequestResponseSchema,
  ThreadFilesUnavailableResponseSchema,
  type ThreadFileVersion,
  ThreadSandboxFilePath,
  ThreadSandboxFilePreviewTooLargeResponseSchema,
} from "@dx/api";
import { ThreadId } from "@dx/domain";
import { Option, Schema } from "effect";
import { type Context, Hono } from "hono";
import type { AppEnv, Bindings } from "../http/types.js";
import { requestThreadDaemon } from "../threads/daemon-client.js";

/**
 * Read-only streaming of any regular file in the Thread sandbox, for opening
 * or downloading files the agent referenced outside the repository. dxd reads
 * one bounded chunk per request; this route stitches chunks into a single
 * HTTP body and fails the stream if the file changes mid-read.
 */

const SANDBOX_PROBE_BYTES = 64 * 1_024;

type Failure = "invalid" | "missing" | "conflict" | "unavailable";

class SandboxFileFailure extends Error {
  constructor(readonly kind: Failure) {
    super(kind);
  }
}

interface Chunk {
  readonly version: ThreadFileVersion;
  readonly sizeBytes: number;
  readonly bytes: Uint8Array;
}

export interface SandboxFileReader {
  readonly readChunk: (
    bindings: Pick<Bindings, "THREAD_EXECUTION">,
    threadId: ThreadId,
    path: ThreadSandboxFilePath,
    offset: number,
    length: number,
    expectedVersion?: ThreadFileVersion,
  ) => Promise<Chunk>;
}

const daemonReader: SandboxFileReader = {
  readChunk: async (
    bindings,
    threadId,
    path,
    offset,
    length,
    expectedVersion,
  ) => {
    const result = await requestThreadDaemon(bindings, threadId, {
      operation: "files.readSandbox",
      path,
      offset,
      length,
      ...(expectedVersion === undefined ? {} : { expectedVersion }),
    }).catch(() => {
      throw new SandboxFileFailure("unavailable");
    });
    if (result.kind !== "sandbox-chunk")
      throw new SandboxFileFailure(result.kind);
    const bytes = result.bytes;
    if (
      result.offset !== offset ||
      bytes.byteLength > length ||
      (offset + bytes.byteLength < result.sizeBytes &&
        bytes.byteLength !== length)
    )
      throw new SandboxFileFailure("unavailable");
    return { version: result.version, sizeBytes: result.sizeBytes, bytes };
  },
};

const INLINE_MEDIA_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  ogv: "video/ogg",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  pdf: "application/pdf",
};

/**
 * Only passive media is labelled with its real type. Everything else is
 * served as plain text or opaque bytes so dx's origin never executes it.
 */
export const sandboxFileMediaType = (path: string, text: boolean) => {
  const extension = path.split("/").at(-1)?.split(".").at(-1)?.toLowerCase();
  // Own keys only: `notes.constructor` must not read Object.prototype.
  const media =
    extension !== undefined && Object.hasOwn(INLINE_MEDIA_TYPES, extension)
      ? INLINE_MEDIA_TYPES[extension]
      : undefined;
  if (media !== undefined) return media;
  return text ? "text/plain; charset=utf-8" : "application/octet-stream";
};

/**
 * Sniff the first chunk. When it is the whole file, decode it completely;
 * otherwise decode in streaming mode so only a code point cut at the chunk
 * boundary is tolerated.
 */
export const looksLikeText = (bytes: Uint8Array, complete: boolean) => {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes, {
      stream: !complete,
    });
    return true;
  } catch {
    return false;
  }
};

// SVG can carry script. It renders passively through <img>, which ignores
// Content-Disposition, but a direct navigation must download it instead.
const renderedAsDocument = (mediaType: string) => mediaType === "image/svg+xml";

const encodeFilename = (path: string) => {
  const name = path.split("/").at(-1) ?? "download";
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
};

type ByteRange = { readonly start: number; readonly end: number };

/** Parse one `bytes=` range. Multi-range requests are served whole. */
export const parseByteRange = (
  header: string | undefined,
  size: number,
): ByteRange | "unsatisfiable" | undefined => {
  if (header === undefined) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return undefined;
  const [, first = "", last = ""] = match;
  if (first === "" && last === "") return undefined;
  if (size === 0) return "unsatisfiable";
  if (first === "") {
    const suffix = Number(last);
    if (suffix === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  if (start >= size) return "unsatisfiable";
  const end = last === "" ? size - 1 : Math.min(Number(last), size - 1);
  return end < start ? "unsatisfiable" : { start, end };
};

const failureResponse = (context: Context<AppEnv>, kind: Failure) => {
  const requestId = context.get("requestId");
  switch (kind) {
    case "invalid":
      return context.json(
        Schema.encodeUnknownSync(ThreadFilesInvalidRequestResponseSchema)({
          status: "error",
          data: {
            code: "THREAD_FILES_INVALID_REQUEST",
            message: "The Files request is invalid.",
            requestId,
          },
        }),
        400,
      );
    case "missing":
      return context.json(
        Schema.encodeUnknownSync(ThreadFilesEntryNotFoundResponseSchema)({
          status: "error",
          data: {
            code: "THREAD_FILES_ENTRY_NOT_FOUND",
            message: "The requested workspace entry was not found.",
            requestId,
          },
        }),
        404,
      );
    case "conflict":
      return context.json(
        Schema.encodeUnknownSync(ThreadFilesConflictResponseSchema)({
          status: "error",
          data: {
            code: "THREAD_FILES_CONFLICT",
            message: "The file changed before the operation completed.",
            requestId,
          },
        }),
        409,
      );
    case "unavailable":
      return context.json(
        Schema.encodeUnknownSync(ThreadFilesUnavailableResponseSchema)({
          status: "error",
          data: {
            code: "THREAD_FILES_UNAVAILABLE",
            message: "Files are temporarily unavailable.",
            requestId,
          },
        }),
        503,
      );
  }
};

const streamRange = (
  read: (offset: number, length: number) => Promise<Chunk>,
  first: Chunk,
  range: ByteRange,
) => {
  let offset = range.start;
  let pending: Chunk | undefined = first;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const remaining = range.end + 1 - offset;
        if (remaining <= 0) {
          controller.close();
          return;
        }
        try {
          const chunk =
            pending ??
            (await read(
              offset,
              Math.min(remaining, THREAD_SANDBOX_FILE_MAX_CHUNK_BYTES),
            ));
          pending = undefined;
          const bytes = chunk.bytes.subarray(0, remaining);
          if (bytes.byteLength === 0) {
            // The file shrank without a version change: never hang.
            controller.error(new SandboxFileFailure("conflict"));
            return;
          }
          offset += bytes.byteLength;
          controller.enqueue(bytes);
        } catch (cause) {
          controller.error(cause);
        }
      },
    },
    { highWaterMark: 0 },
  );
};

const decodeQueryPath = (context: Context<AppEnv>) => {
  const params = new URL(context.req.url).searchParams;
  for (const [key] of params)
    if (!["path", "download"].includes(key) || params.getAll(key).length !== 1)
      throw new SandboxFileFailure("invalid");
  const download = params.get("download");
  if (download !== null && download !== "1")
    throw new SandboxFileFailure("invalid");
  const threadId = Schema.decodeUnknownOption(ThreadId)(
    context.req.param("threadId"),
  );
  const path = Schema.decodeUnknownOption(ThreadSandboxFilePath)(
    params.get("path"),
  );
  if (Option.isNone(threadId) || Option.isNone(path))
    throw new SandboxFileFailure("invalid");
  return {
    threadId: threadId.value,
    path: path.value,
    download: download === "1",
  };
};

export const makeThreadSandboxFileRoutes = (
  reader: SandboxFileReader = daemonReader,
) => {
  const routes = new Hono<AppEnv>();
  const serve = async (context: Context<AppEnv>, head: boolean) => {
    try {
      const { threadId, path, download } = decodeQueryPath(context);
      const read = (
        offset: number,
        length: number,
        expectedVersion?: ThreadFileVersion,
      ) =>
        reader.readChunk(
          context.env,
          threadId,
          path,
          offset,
          length,
          expectedVersion,
        );
      // A small first read proves the file, fixes its version, and sniffs
      // text without pulling a full chunk for every media Range request.
      const probe = await read(0, SANDBOX_PROBE_BYTES);
      const size = probe.sizeBytes;
      if (!download && size > THREAD_SANDBOX_FILE_MAX_PREVIEW_BYTES)
        return context.json(
          Schema.encodeUnknownSync(
            ThreadSandboxFilePreviewTooLargeResponseSchema,
          )({
            status: "error",
            data: {
              code: "THREAD_SANDBOX_FILE_PREVIEW_TOO_LARGE",
              message:
                "This file is too large to preview. Download it instead.",
              requestId: context.get("requestId"),
            },
          }),
          413,
        );
      const mediaType = sandboxFileMediaType(
        path,
        looksLikeText(probe.bytes, probe.bytes.byteLength >= size),
      );
      const attachment = download || renderedAsDocument(mediaType);
      const headers = new Headers({
        "accept-ranges": "bytes",
        "cache-control": "private, no-store",
        "content-disposition": `${attachment ? "attachment" : "inline"}; ${encodeFilename(path)}`,
        "content-security-policy": "default-src 'none'; sandbox",
        "content-type": mediaType,
        "x-content-type-options": "nosniff",
        "x-dx-file-version": probe.version,
      });
      const requested = parseByteRange(context.req.header("range"), size);
      if (requested === "unsatisfiable") {
        headers.set("content-range", `bytes */${size}`);
        return new Response(null, { status: 416, headers });
      }
      const range = requested ?? { start: 0, end: size - 1 };
      const length = size === 0 ? 0 : range.end - range.start + 1;
      headers.set("content-length", String(length));
      if (requested !== undefined)
        headers.set(
          "content-range",
          `bytes ${range.start}-${range.end}/${size}`,
        );
      const status = requested === undefined ? 200 : 206;
      if (head || length === 0) return new Response(null, { status, headers });
      const first =
        range.start === 0
          ? probe
          : await read(
              range.start,
              Math.min(length, THREAD_SANDBOX_FILE_MAX_CHUNK_BYTES),
              probe.version,
            );
      const body = streamRange(
        (offset, chunkLength) => read(offset, chunkLength, probe.version),
        first,
        range,
      );
      return new Response(body, { status, headers });
    } catch (cause) {
      return failureResponse(
        context,
        cause instanceof SandboxFileFailure ? cause.kind : "unavailable",
      );
    }
  };
  routes.get("/:threadId/files-sandbox", (context) =>
    serve(context, context.req.method === "HEAD"),
  );
  return routes;
};

export const threadSandboxFileRoutes = makeThreadSandboxFileRoutes();
