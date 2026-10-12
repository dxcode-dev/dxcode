import { Schema } from "effect";

/**
 * File attachments: the browser uploads a file to Core before it sends the
 * message, and the message carries only a reference to it. The agent never
 * receives the bytes in its context; it downloads the file into its Orb with
 * `dxd files get <url>` when it needs it.
 */

/** The largest file one attachment may hold. */
export const MAX_ATTACHMENT_BYTES = 500 * 1024 * 1024;
/** The most files one message may reference. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;
/**
 * Uploads go to Core in parts of exactly this size (the last may be smaller),
 * so no request approaches the platform's request-body limit. R2 requires
 * equal parts of at least 5 MiB except the last.
 */
export const ATTACHMENT_PART_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENT_FILENAME_LENGTH = 255;

export const ATTACHMENT_ID_PATTERN = /^att_[0-9a-f]{32}$/;
export const AttachmentIdSchema = Schema.String.check(
  Schema.isPattern(ATTACHMENT_ID_PATTERN),
);

export const CreateAttachmentRequestSchema = Schema.Struct({
  filename: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_ATTACHMENT_FILENAME_LENGTH * 4),
  ),
  mimeType: Schema.String.check(Schema.isMaxLength(255)),
  size: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(MAX_ATTACHMENT_BYTES),
  ),
});
export type CreateAttachmentRequest = typeof CreateAttachmentRequestSchema.Type;

/**
 * Where the browser sends one part: a presigned R2 URL in deployed stages,
 * so the bytes go straight to storage, or a Core path in local development.
 * The response's `ETag` header identifies the stored part.
 */
export const AttachmentPartTargetSchema = Schema.Struct({
  partNumber: Schema.Number,
  url: Schema.String,
});
export type AttachmentPartTarget = typeof AttachmentPartTargetSchema.Type;

export const CreateAttachmentResponseSchema = Schema.Struct({
  id: AttachmentIdSchema,
  partSize: Schema.Number,
  partCount: Schema.Number,
  parts: Schema.Array(AttachmentPartTargetSchema),
});
export type CreateAttachmentResponse =
  typeof CreateAttachmentResponseSchema.Type;

export const AttachmentPartResponseSchema = Schema.Struct({
  partNumber: Schema.Number,
  etag: Schema.String,
});
export type AttachmentPartResponse = typeof AttachmentPartResponseSchema.Type;

export const CompleteAttachmentRequestSchema = Schema.Struct({
  parts: Schema.Array(AttachmentPartResponseSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(Math.ceil(MAX_ATTACHMENT_BYTES / ATTACHMENT_PART_BYTES)),
  ),
});
export type CompleteAttachmentRequest =
  typeof CompleteAttachmentRequestSchema.Type;

export const AttachmentDataSchema = Schema.Struct({
  id: AttachmentIdSchema,
  filename: Schema.String,
  mimeType: Schema.String,
  size: Schema.Number,
  url: Schema.String,
});
export type AttachmentData = typeof AttachmentDataSchema.Type;

/**
 * Image types every supported browser renders. Other images (HEIC, SVG)
 * are offered as files to download, never previewed.
 */
export const PREVIEWABLE_IMAGE_TYPES: ReadonlyArray<string> = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
];
/** Video and audio types dx plays in the chat. */
export const PLAYABLE_MEDIA_TYPES: ReadonlyArray<string> = [
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "audio/mpeg",
  "audio/wav",
  "audio/ogg",
  "audio/mp4",
];

export const AttachmentErrorSchema = Schema.Struct({ error: Schema.String });
export type AttachmentError = typeof AttachmentErrorSchema.Type;

/**
 * A file name that is safe in a URL path segment, a header, and a guest file
 * system: no directory separators, control characters, or leading dots, and
 * at most 255 characters.
 */
export const sanitizeAttachmentFilename = (name: string) => {
  const cleaned = [...name.normalize("NFC")]
    .map((character) =>
      /[\p{Cc}\p{Cf}/\\:*?"<>|]/u.test(character) ? "_" : character,
    )
    .join("")
    .replace(/^[.\s]+/, "")
    .trim();
  const limited = [...cleaned]
    .slice(0, MAX_ATTACHMENT_FILENAME_LENGTH)
    .join("");
  return limited === "" ? "file" : limited;
};

/** The path of an attachment's download route, relative to Core's origin. */
export const attachmentPath = (id: string, filename: string) =>
  `/v1/attachments/${id}/${encodeURIComponent(filename)}`;

export * from "./message-attachments.js";
