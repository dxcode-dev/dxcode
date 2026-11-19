import {
  ARTIFACT_IMAGE_MAX_BYTES,
  parseThreadStorageUrl,
  sanitizeAttachmentFilename,
  threadStoragePath,
} from "@dx/api";
import type { BoardImage } from "@dx/domain";
import {
  attachmentOrigin,
  findAttachment,
  sniffAttachmentType,
} from "../attachments/store.js";
import type { Bindings } from "../http/types.js";
import {
  findThreadStorageFile,
  isReadableThreadStorageFile,
  putThreadStorageFile,
} from "../thread-storage/store.js";
import {
  putStandaloneImage,
  standaloneImagePath,
} from "./standalone-images.js";
import type { ArtifactThreadId } from "./store.js";

/**
 * Images an artifact shows: the types it takes, their stored names, and the
 * agent's way to put a stored file on a board. People's uploads and the
 * agent's images land in the same place: a Thread's storage for a Thread's
 * artifact, the artifact's own prefix for a standalone one. Either way they
 * last as long as the artifact and open for whoever may open it.
 */

export const ARTIFACT_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

const EXTENSION: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** A safe file name for the image, with the extension its bytes call for. */
export const imageName = (requested: string | undefined, mimeType: string) => {
  const base =
    sanitizeAttachmentFilename(requested ?? "")
      .replace(/\.[A-Za-z0-9]{1,5}$/, "")
      .slice(0, 80) || "image";
  return `${base}.${EXTENSION[mimeType] ?? "img"}`;
};

const u16be = (bytes: Uint8Array, at: number) =>
  ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
const u16le = (bytes: Uint8Array, at: number) =>
  (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
const u24le = (bytes: Uint8Array, at: number) =>
  u16le(bytes, at) | ((bytes[at + 2] ?? 0) << 16);
const u32be = (bytes: Uint8Array, at: number) =>
  ((u16be(bytes, at) << 16) >>> 0) + u16be(bytes, at + 2);

/** An image's size in pixels from its header; undefined when unreadable. */
export const imageSize = (
  bytes: Uint8Array,
  mimeType: string,
): { readonly width: number; readonly height: number } | undefined => {
  const size = (width: number, height: number) =>
    width > 0 && height > 0 ? { width, height } : undefined;
  switch (mimeType) {
    case "image/png":
      return size(u32be(bytes, 16), u32be(bytes, 20));
    case "image/gif":
      return size(u16le(bytes, 6), u16le(bytes, 8));
    case "image/webp": {
      const chunk = String.fromCharCode(...bytes.subarray(12, 16));
      if (chunk === "VP8X")
        return size(u24le(bytes, 24) + 1, u24le(bytes, 27) + 1);
      if (chunk === "VP8L") {
        const bits =
          (bytes[21] ?? 0) |
          ((bytes[22] ?? 0) << 8) |
          ((bytes[23] ?? 0) << 16) |
          ((bytes[24] ?? 0) << 24);
        return size((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
      }
      if (chunk === "VP8 ")
        return size(u16le(bytes, 26) & 0x3fff, u16le(bytes, 28) & 0x3fff);
      return undefined;
    }
    case "image/jpeg": {
      // The first start-of-frame marker holds the size.
      let at = 2;
      while (at + 9 < bytes.length) {
        if (bytes[at] !== 0xff) return undefined;
        const marker = bytes[at + 1] ?? 0;
        if (
          marker >= 0xc0 &&
          marker <= 0xcf &&
          marker !== 0xc4 &&
          marker !== 0xc8 &&
          marker !== 0xcc
        )
          return size(u16be(bytes, at + 7), u16be(bytes, at + 5));
        at += 2 + u16be(bytes, at + 2);
      }
      return undefined;
    }
    default:
      return undefined;
  }
};

/** Where an artifact keeps its images. */
export interface ArtifactImageHome {
  readonly threadId: ArtifactThreadId;
  readonly artifactId: string;
}

/** Stores image bytes for an artifact; the path people's editors read. */
const storeImage = async (
  bindings: Pick<Bindings, "DB" | "DX_STORAGE">,
  home: ArtifactImageHome,
  image: {
    readonly name: string;
    readonly mimeType: string;
    readonly bytes: Uint8Array;
  },
) => {
  if (home.threadId === null) {
    if (bindings.DX_STORAGE === undefined)
      throw new Error("Image storage is not configured.");
    const id = await putStandaloneImage(bindings.DX_STORAGE, {
      artifactId: home.artifactId,
      ...image,
    });
    return { id, path: standaloneImagePath(home.artifactId, id, image.name) };
  }
  const id = await putThreadStorageFile(bindings, {
    threadId: home.threadId,
    ...image,
  });
  return { id, path: threadStoragePath(home.threadId, id, image.name) };
};

const ATTACHMENT_PATH = /^\/v1\/attachments\/(att_[0-9a-f]{32})(?:\/[^/]*)?$/;

/**
 * Reads the image a board line's `src` names, as the Thread `threadId`'s
 * agent may: a file in that Thread's storage (`dxd files put`), or a file
 * someone attached to a message in it. Anything else is refused with what
 * to do instead.
 */
const readSource = async (
  bindings: Pick<Bindings, "DB" | "DX_STORAGE" | "DX_AUTH_URL">,
  threadId: string,
  src: string,
) => {
  const db = bindings.DB;
  const bucket = bindings.DX_STORAGE;
  if (db === undefined || bucket === undefined)
    throw new Error("Image storage is not configured.");
  const origin = attachmentOrigin(bindings as Bindings, "http://localhost");
  const refuse = (why: string) =>
    new Error(
      `src=${src} ${why}. Nothing was saved. Store the image with \`dxd files put <path>\` and use the URL it prints.`,
    );
  let url: URL;
  try {
    url = new URL(src, origin);
  } catch {
    throw refuse("is not a URL");
  }
  // dx's own read routes; a path, or a URL on any of dx's addresses.
  const path = url.pathname;
  const located = parseThreadStorageUrl(path, origin);
  let object: { key: string; name: string; size: number } | undefined;
  if (located !== undefined) {
    const row = await findThreadStorageFile(db, located.id);
    if (
      row === null ||
      !isReadableThreadStorageFile(row, Date.now()) ||
      row.thread_id !== located.threadId
    )
      throw refuse("names no stored file");
    if (row.thread_id !== threadId)
      throw refuse("is another Thread's file, which this Thread cannot use");
    object = { key: row.object_key, name: row.name, size: row.size };
  } else {
    const attachment = ATTACHMENT_PATH.exec(path)?.[1];
    if (attachment === undefined) throw refuse("is not a file stored with dx");
    const row = await findAttachment(db, attachment);
    const sent =
      row !== null &&
      row.state === "ready" &&
      (await db
        .prepare(
          "SELECT 1 FROM attachment_threads WHERE attachment_id = ? AND thread_id = ?",
        )
        .bind(attachment, threadId)
        .first()) !== null;
    if (row === null || !sent)
      throw refuse("is not a file sent in this Thread");
    object = { key: row.object_key, name: row.filename, size: row.size };
  }
  if (object.size > ARTIFACT_IMAGE_MAX_BYTES)
    throw refuse(
      `is ${object.size} bytes; an image on a board is at most ${ARTIFACT_IMAGE_MAX_BYTES} bytes`,
    );
  const stored = await bucket.get(object.key);
  if (stored === null) throw refuse("names no stored file");
  const bytes = new Uint8Array(await stored.arrayBuffer());
  // The type comes from the bytes, never the name.
  const mimeType = sniffAttachmentType(bytes.subarray(0, 64));
  if (mimeType === undefined || !ARTIFACT_IMAGE_TYPES.has(mimeType))
    throw refuse("is not a PNG, JPEG, GIF, or WebP image");
  const size = imageSize(bytes, mimeType);
  if (size === undefined) throw refuse("is not a readable image");
  return { name: object.name, mimeType, bytes, ...size };
};

/**
 * Copies each image the agent's board text names into the board's own
 * image storage, so it shows for everyone who may open the board, for as
 * long as the board lasts, whatever happens to the source file. Throws a
 * message for the agent when one cannot be used; nothing is saved then.
 */
export const storeBoardImages = async (
  bindings: Pick<Bindings, "DB" | "DX_STORAGE" | "DX_AUTH_URL">,
  input: {
    /** The Thread whose agent writes the board. */
    readonly threadId: string;
    readonly home: ArtifactImageHome;
    readonly sources: ReadonlyArray<string>;
  },
): Promise<ReadonlyMap<string, BoardImage>> => {
  const images = new Map<string, BoardImage>();
  if (input.sources.length > 20)
    throw new Error(
      `The board text adds ${input.sources.length} new images; add at most 20 in one call. Nothing was saved.`,
    );
  for (const src of input.sources) {
    const source = await readSource(bindings, input.threadId, src);
    const name = imageName(source.name, source.mimeType);
    const stored = await storeImage(bindings, input.home, {
      name,
      mimeType: source.mimeType,
      bytes: source.bytes,
    });
    images.set(src, {
      fileId: stored.id,
      mimeType: source.mimeType,
      url: stored.path,
      width: source.width,
      height: source.height,
    });
  }
  return images;
};
