import {
  ATTACHMENT_ID_PATTERN,
  ATTACHMENT_PART_BYTES,
  type AttachmentData,
  attachmentPath,
  PLAYABLE_MEDIA_TYPES,
  PREVIEWABLE_IMAGE_TYPES,
} from "@dx/api";
import type { Bindings } from "../http/types.js";
import type { AttachmentTransfer } from "./transfer.js";

/**
 * One uploaded file: its D1 row and R2 object. `attachment_threads` records
 * every Thread a message sent it in.
 */
export interface AttachmentRow {
  readonly id: string;
  readonly uploader_user_id: string;
  readonly object_key: string;
  readonly upload_id: string | null;
  readonly filename: string;
  readonly mime_type: string;
  readonly size: number;
  readonly state: "uploading" | "ready";
  readonly created_at: number;
}

export class AttachmentStorageUnavailable extends Error {
  constructor() {
    super("Attachment storage is unavailable.");
  }
}

export const attachmentBindings = (bindings: Bindings) => {
  if (bindings.DB === undefined || bindings.DX_STORAGE === undefined)
    throw new AttachmentStorageUnavailable();
  return { db: bindings.DB, bucket: bindings.DX_STORAGE };
};

export const newAttachmentId = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `att_${[...bytes].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
};

export const isAttachmentId = (value: string | undefined): value is string =>
  value !== undefined && ATTACHMENT_ID_PATTERN.test(value);

export const attachmentObjectKey = (uploaderUserId: string, id: string) =>
  `attachments/${uploaderUserId}/${id}`;

export const attachmentPartCount = (size: number) =>
  Math.max(1, Math.ceil(size / ATTACHMENT_PART_BYTES));

/** The byte length part `partNumber` (1-based) must have. */
export const attachmentPartLength = (size: number, partNumber: number) => {
  const count = attachmentPartCount(size);
  if (partNumber < 1 || partNumber > count) return undefined;
  return partNumber < count
    ? ATTACHMENT_PART_BYTES
    : size - ATTACHMENT_PART_BYTES * (count - 1);
};

/** Core's public origin: the configured auth URL, else this request's. */
export const attachmentOrigin = (bindings: Bindings, requestUrl: string) => {
  try {
    return new URL(bindings.DX_AUTH_URL ?? "").origin;
  } catch {
    return new URL(requestUrl).origin;
  }
};

export const attachmentData = (
  row: Pick<AttachmentRow, "id" | "filename" | "mime_type" | "size">,
  origin: string,
): AttachmentData => ({
  id: row.id,
  filename: row.filename,
  mimeType: row.mime_type,
  size: row.size,
  url: `${origin}${attachmentPath(row.id, row.filename)}`,
});

export const findAttachment = (db: D1Database, id: string) =>
  db
    .prepare("SELECT * FROM attachments WHERE id = ?")
    .bind(id)
    .first<AttachmentRow>();

const startsWith = (bytes: Uint8Array, signature: ReadonlyArray<number>) =>
  bytes.length >= signature.length &&
  signature.every((value, index) => bytes[index] === value);

const ascii = (bytes: Uint8Array, start: number, end: number) =>
  String.fromCharCode(...bytes.subarray(start, end));

/** The type a file's first bytes prove, for the formats dx previews. */
export const sniffAttachmentType = (bytes: Uint8Array): string | undefined => {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP")
    return "image/webp";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WAVE")
    return "audio/wav";
  if (ascii(bytes, 0, 5) === "%PDF-") return "application/pdf";
  if (ascii(bytes, 4, 8) === "ftyp") {
    const brand = ascii(bytes, 8, 12);
    if (brand === "qt  ") return "video/quicktime";
    if (brand.startsWith("M4A")) return "audio/mp4";
    if (brand === "avif" || brand === "avis") return "image/avif";
    if (brand === "heic" || brand === "heix" || brand === "mif1")
      return "image/heic";
    return "video/mp4";
  }
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return "video/webm";
  if (ascii(bytes, 0, 4) === "OggS") return "audio/ogg";
  if (ascii(bytes, 0, 3) === "ID3" || startsWith(bytes, [0xff, 0xfb]))
    return "audio/mpeg";
  return undefined;
};

const PREVIEWED_FAMILIES = /^(image|video|audio)\/|^application\/pdf$/;
const MIME_TYPE = /^[a-z0-9][a-z0-9.+-]{0,126}\/[a-z0-9][a-z0-9.+-]{0,126}$/;

/**
 * The type dx records for an upload. A previewable type must be proved by
 * the file's bytes, so a renamed file cannot pose as an image or video; any
 * other declared type is kept for display only.
 */
export const resolveAttachmentType = (declared: string, head: Uint8Array) => {
  const sniffed = sniffAttachmentType(head);
  if (sniffed !== undefined) return sniffed;
  const normalized = declared.trim().toLowerCase().split(";")[0] ?? "";
  if (!MIME_TYPE.test(normalized) || PREVIEWED_FAMILIES.test(normalized))
    return "application/octet-stream";
  return normalized;
};

/**
 * Types shown inline: previewable images, playable media, and PDF. Anything
 * else, including SVG and HTML, which can carry script, downloads instead.
 */
const INLINE_TYPES = new Set([
  ...PREVIEWABLE_IMAGE_TYPES,
  ...PLAYABLE_MEDIA_TYPES,
  "application/pdf",
]);

/** How a read presents the file: inline media or a download. */
export const attachmentResponseType = (
  row: Pick<AttachmentRow, "mime_type" | "filename">,
  download: boolean,
) => {
  const inline = !download && INLINE_TYPES.has(row.mime_type);
  return {
    contentType: inline ? row.mime_type : "application/octet-stream",
    disposition: `${inline ? "inline" : "attachment"}; ${encodeFilename(row.filename)}`,
  };
};

const encodeFilename = (name: string) => {
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
};

type ByteRange = { readonly start: number; readonly end: number };

/** Parse one `bytes=` range. Multi-range requests are served whole. */
export const parseAttachmentRange = (
  header: string | undefined | null,
  size: number,
): ByteRange | "unsatisfiable" | undefined => {
  if (header === undefined || header === null) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return undefined;
  const [, first = "", last = ""] = match;
  if (first === "" && last === "") return undefined;
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

/** The first bytes of an object, for type sniffing. */
export const readAttachmentHead = async (
  bucket: R2Bucket,
  key: string,
  size: number,
) => {
  const object = await bucket.get(key, {
    range: { offset: 0, length: Math.min(64, size) },
  });
  if (object === null) return new Uint8Array();
  return new Uint8Array(await object.arrayBuffer());
};

/** Unsent uploads older than this are deleted. */
export const UNSENT_ATTACHMENT_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Delete uploads no message sent within a day: the composer was closed, the
 * file removed while its delete failed, or the upload never finished. Runs
 * for one uploader whenever they start an upload, and for everyone from the
 * scheduled job where a deployment has one.
 */
export const purgeUnsentAttachments = async (
  bindings: Pick<Bindings, "DB" | "DX_STORAGE">,
  transfer: AttachmentTransfer,
  now: number,
  options: { readonly uploaderUserId?: string; readonly limit: number },
) => {
  if (bindings.DB === undefined || bindings.DX_STORAGE === undefined) return 0;
  const { results } = await bindings.DB.prepare(
    `SELECT * FROM attachments
      WHERE created_at < ?
        AND (? IS NULL OR uploader_user_id = ?)
        AND NOT EXISTS (
          SELECT 1 FROM attachment_threads
           WHERE attachment_threads.attachment_id = attachments.id
        )
      LIMIT ?`,
  )
    .bind(
      now - UNSENT_ATTACHMENT_RETENTION_MS,
      options.uploaderUserId ?? null,
      options.uploaderUserId ?? null,
      options.limit,
    )
    .all<AttachmentRow>();
  let deleted = 0;
  for (const row of results) {
    if (
      !(await deleteUnsentAttachment(
        bindings.DB,
        bindings.DX_STORAGE,
        transfer,
        row,
      ))
    )
      continue;
    deleted++;
  }
  return deleted;
};

/**
 * Delete an upload no message has sent, row first so a racing admission
 * cannot send a file whose bytes are going. Returns false when a message
 * sent it meanwhile.
 */
export const deleteUnsentAttachment = async (
  db: D1Database,
  bucket: R2Bucket,
  transfer: AttachmentTransfer,
  row: AttachmentRow,
) => {
  const removed = await db
    .prepare(
      `DELETE FROM attachments
        WHERE id = ?
          AND NOT EXISTS (
            SELECT 1 FROM attachment_threads WHERE attachment_id = ?
          )`,
    )
    .bind(row.id, row.id)
    .run();
  if (removed.meta.changes === 0) return false;
  if (row.state === "uploading" && row.upload_id !== null)
    await transfer.abort(row.object_key, row.upload_id).catch(() => undefined);
  else await bucket.delete(row.object_key);
  return true;
};
