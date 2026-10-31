import { Effect } from "effect";
import { PluginBundleRejected } from "./errors.js";

export { PluginBundleRejected };

/**
 * A minimal reader for untrusted ZIP archives. It parses the central
 * directory, refuses names that escape the archive root, and inflates only the
 * entries a caller asks for, never past a byte limit. ZIP64, multi-disk, and
 * encrypted archives are not supported.
 */

export interface ZipEntry {
  readonly path: string;
  readonly method: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly localOffset: number;
  readonly symlink: boolean;
  readonly encrypted: boolean;
}

export type ZipText =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: string };

export interface ZipArchive {
  /** The archive comment; GitHub archives hold the commit SHA here. */
  readonly comment: string;
  /** Files only; directory entries are left out. */
  readonly entries: ReadonlyArray<ZipEntry>;
  readonly readText: (
    entry: ZipEntry,
    maxBytes: number,
  ) => Effect.Effect<ZipText, PluginBundleRejected>;
}

export interface ZipLimits {
  readonly maxArchiveBytes: number;
  readonly maxEntries: number;
}

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

const notZip = () =>
  new PluginBundleRejected({ reason: "The file is not a valid ZIP archive." });

const decoder = new TextDecoder("utf-8", { fatal: true });
const lenientDecoder = new TextDecoder("utf-8");

/** Whether an entry name stays inside the archive root. */
export const safeArchivePath = (path: string): boolean => {
  if (
    path.length === 0 ||
    path.length > 1024 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    /^[A-Za-z]:/.test(path)
  ) {
    return false;
  }
  return path
    .replace(/\/$/, "")
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
};

const findEnd = (view: DataView): number => {
  const earliest = Math.max(0, view.byteLength - 22 - 0xffff);
  for (let offset = view.byteLength - 22; offset >= earliest; offset -= 1) {
    if (view.getUint32(offset, true) === END_OF_CENTRAL_DIRECTORY) {
      const commentLength = view.getUint16(offset + 20, true);
      if (offset + 22 + commentLength === view.byteLength) return offset;
    }
  }
  return -1;
};

const inflate = async (
  data: Uint8Array,
  maxBytes: number,
): Promise<Uint8Array | "too-large" | "corrupt"> => {
  const reader = new Blob([data.slice()])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"))
    .getReader();
  const chunks: Array<Uint8Array> = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return "too-large";
      }
      chunks.push(value);
    }
  } catch {
    return "corrupt";
  }
  const output = new Uint8Array(total);
  let position = 0;
  for (const chunk of chunks) {
    output.set(chunk, position);
    position += chunk.byteLength;
  }
  return output;
};

export const readZipArchive = Effect.fn("readZipArchive")(function* (
  bytes: Uint8Array,
  limits: ZipLimits,
) {
  if (bytes.byteLength > limits.maxArchiveBytes) {
    return yield* new PluginBundleRejected({
      reason: `The archive is larger than ${limits.maxArchiveBytes.toLocaleString("en-US")} bytes.`,
    });
  }
  if (bytes.byteLength < 22) return yield* notZip();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = findEnd(view);
  if (end < 0) return yield* notZip();
  const disk = view.getUint16(end + 4, true);
  const centralDisk = view.getUint16(end + 6, true);
  const count = view.getUint16(end + 10, true);
  const centralSize = view.getUint32(end + 12, true);
  const centralOffset = view.getUint32(end + 16, true);
  const commentLength = view.getUint16(end + 20, true);
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    count === 0xffff ||
    centralOffset === 0xffffffff ||
    centralOffset + centralSize > end
  ) {
    return yield* notZip();
  }
  if (count > limits.maxEntries) {
    return yield* new PluginBundleRejected({
      reason: `The archive has more than ${limits.maxEntries.toLocaleString("en-US")} entries.`,
    });
  }
  const comment = lenientDecoder.decode(
    bytes.subarray(end + 22, end + 22 + commentLength),
  );
  const entries: Array<ZipEntry> = [];
  const seen = new Set<string>();
  let offset = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (
      offset + 46 > end ||
      view.getUint32(offset, true) !== CENTRAL_DIRECTORY_HEADER
    ) {
      return yield* notZip();
    }
    const madeBy = view.getUint16(offset + 4, true);
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const entryCommentLength = view.getUint16(offset + 32, true);
    const external = view.getUint32(offset + 38, true);
    const localOffset = view.getUint32(offset + 42, true);
    const nameEnd = offset + 46 + nameLength;
    if (nameEnd > end) return yield* notZip();
    const path = lenientDecoder.decode(bytes.subarray(offset + 46, nameEnd));
    offset = nameEnd + extraLength + entryCommentLength;
    if (!safeArchivePath(path)) {
      return yield* new PluginBundleRejected({
        reason: `The archive contains an unsafe path: ${JSON.stringify(path.slice(0, 200))}.`,
      });
    }
    if (seen.has(path)) {
      return yield* new PluginBundleRejected({
        reason: `The archive lists ${JSON.stringify(path.slice(0, 200))} twice.`,
      });
    }
    seen.add(path);
    if (
      compressedSize === 0xffffffff ||
      size === 0xffffffff ||
      localOffset === 0xffffffff
    ) {
      return yield* notZip();
    }
    if (path.endsWith("/")) continue;
    const unix = madeBy >> 8 === 3;
    entries.push({
      path,
      method,
      compressedSize,
      size,
      localOffset,
      symlink: unix && ((external >>> 16) & S_IFMT) === S_IFLNK,
      encrypted: (flags & 1) === 1,
    });
  }

  const readText = Effect.fn("ZipArchive.readText")(function* (
    entry: ZipEntry,
    maxBytes: number,
  ) {
    if (entry.symlink) {
      return { ok: false, reason: "Symbolic links are not imported." } as const;
    }
    if (entry.encrypted) {
      return {
        ok: false,
        reason: "Encrypted files are not imported.",
      } as const;
    }
    if (entry.method !== 0 && entry.method !== 8) {
      return {
        ok: false,
        reason: "The file uses an unsupported compression method.",
      } as const;
    }
    const tooLarge = {
      ok: false,
      reason: `The file is larger than ${maxBytes.toLocaleString("en-US")} bytes.`,
    } as const;
    if (entry.size > maxBytes) return tooLarge;
    const local = entry.localOffset;
    if (
      local + 30 > centralOffset ||
      view.getUint32(local, true) !== LOCAL_FILE_HEADER
    ) {
      return yield* notZip();
    }
    const dataStart =
      local +
      30 +
      view.getUint16(local + 26, true) +
      view.getUint16(local + 28, true);
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > centralOffset) return yield* notZip();
    const data = bytes.subarray(dataStart, dataEnd);
    let content: Uint8Array;
    if (entry.method === 0) {
      if (entry.compressedSize !== entry.size) return yield* notZip();
      content = data;
    } else {
      const inflated = yield* Effect.promise(() =>
        inflate(data, Math.min(maxBytes, entry.size)),
      );
      if (inflated === "corrupt") return yield* notZip();
      if (inflated === "too-large") {
        return {
          ok: false,
          reason: "The file is larger than its header says.",
        } as const;
      }
      if (inflated.byteLength !== entry.size) return yield* notZip();
      content = inflated;
    }
    try {
      const text = decoder.decode(content);
      if (text.includes("\0")) {
        return { ok: false, reason: "The file is not UTF-8 text." } as const;
      }
      return { ok: true, text } as const;
    } catch {
      return { ok: false, reason: "The file is not UTF-8 text." } as const;
    }
  });

  return { comment, entries, readText } satisfies ZipArchive;
});
