import { Schema } from "effect";
import {
  ATTACHMENT_PART_BYTES,
  AttachmentPartResponseSchema,
  AttachmentPartTargetSchema,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_FILENAME_LENGTH,
} from "../attachments/index.js";

/**
 * Thread storage: files a Thread keeps in dx, outside its Orb. The bytes live
 * in R2 and outlive the sandbox, so a screenshot or recording the agent shows
 * in the transcript still loads after the Orb sleeps, stops, or is gone.
 *
 * Only the Thread itself writes to its storage, from its Orb with
 * `dxd files put <path>`, which authenticates with the Thread's daemon key.
 * Anyone who can read the Thread reads its files, in the browser with their
 * session or from another Thread's Orb with `dxd files get <url>`.
 */

/** The largest file Thread storage holds, the same as an attachment. */
export const MAX_THREAD_STORAGE_FILE_BYTES = MAX_ATTACHMENT_BYTES;
/** Uploads go straight to R2 in parts of this size; the last may be smaller. */
export const THREAD_STORAGE_PART_BYTES = ATTACHMENT_PART_BYTES;

export const THREAD_STORAGE_FILE_ID_PATTERN = /^tsf_[0-9a-f]{32}$/;
export const ThreadStorageFileIdSchema = Schema.String.check(
  Schema.isPattern(THREAD_STORAGE_FILE_ID_PATTERN),
);

export const CreateThreadStorageFileRequestSchema = Schema.Struct({
  name: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_ATTACHMENT_FILENAME_LENGTH * 4),
  ),
  mimeType: Schema.String.check(Schema.isMaxLength(255)),
  size: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(MAX_THREAD_STORAGE_FILE_BYTES),
  ),
});
export type CreateThreadStorageFileRequest =
  typeof CreateThreadStorageFileRequestSchema.Type;

/** Where dxd PUTs each part: presigned R2 URLs that sign each part's length. */
export const CreateThreadStorageFileResponseSchema = Schema.Struct({
  id: ThreadStorageFileIdSchema,
  partSize: Schema.Number,
  partCount: Schema.Number,
  parts: Schema.Array(AttachmentPartTargetSchema),
});
export type CreateThreadStorageFileResponse =
  typeof CreateThreadStorageFileResponseSchema.Type;

export const CompleteThreadStorageFileRequestSchema = Schema.Struct({
  parts: Schema.Array(AttachmentPartResponseSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(
      Math.ceil(MAX_THREAD_STORAGE_FILE_BYTES / THREAD_STORAGE_PART_BYTES),
    ),
  ),
});
export type CompleteThreadStorageFileRequest =
  typeof CompleteThreadStorageFileRequestSchema.Type;

export const ThreadStorageFileSchema = Schema.Struct({
  id: ThreadStorageFileIdSchema,
  threadId: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  size: Schema.Number,
  /** Absolute URL on dx's origin; it needs a dx session to open. */
  url: Schema.String,
  createdAt: Schema.Number,
});
export type ThreadStorageFile = typeof ThreadStorageFileSchema.Type;

export const ThreadStorageListResponseSchema = Schema.Struct({
  files: Schema.Array(ThreadStorageFileSchema),
});
export type ThreadStorageListResponse =
  typeof ThreadStorageListResponseSchema.Type;

export const ThreadStorageErrorSchema = Schema.Struct({ error: Schema.String });
export type ThreadStorageError = typeof ThreadStorageErrorSchema.Type;

/** The read route of a stored file, relative to dx's origin. */
export const threadStoragePath = (threadId: string, id: string, name: string) =>
  `/v1/threads/${encodeURIComponent(threadId)}/storage/${id}/${encodeURIComponent(name)}`;

const STORAGE_PATH =
  /^\/v1\/threads\/(thr_[0-9a-f-]{36})\/storage\/(tsf_[0-9a-f]{32})(?:\/([^/?#]*))?$/;

export interface ThreadStorageLocation {
  readonly threadId: string;
  readonly id: string;
  /** The file name the URL ends with, decoded; empty when it has none. */
  readonly name: string;
  /** The read route as a path on dx's origin. */
  readonly path: string;
}

/**
 * The stored file a URL names, when it is a read route on `origin`: a path,
 * or an absolute URL on that origin. A URL on any other origin is not one,
 * so a transcript never loads a look-alike from another host.
 */
export const parseThreadStorageUrl = (
  value: string,
  origin: string,
): ThreadStorageLocation | undefined => {
  let url: URL;
  try {
    url = new URL(value, origin);
  } catch {
    return undefined;
  }
  if (url.origin !== new URL(origin).origin || url.search !== "")
    return undefined;
  const match = STORAGE_PATH.exec(url.pathname);
  if (match === null) return undefined;
  const [, threadId = "", id = "", encoded = ""] = match;
  let name: string;
  try {
    name = decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
  return { threadId, id, name, path: url.pathname };
};
