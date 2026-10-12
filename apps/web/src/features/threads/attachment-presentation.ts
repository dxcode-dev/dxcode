/** How the composer and transcript label and preview a file. */

import { PLAYABLE_MEDIA_TYPES, PREVIEWABLE_IMAGE_TYPES } from "@dx/api";

export type PreviewKind = "image" | "video" | "file";

/**
 * How a file previews. Only images every browser renders show as images
 * (HEIC and SVG do not), and only media dx plays show as video.
 */
export const attachmentPreviewKind = (mimeType: string): PreviewKind =>
  PREVIEWABLE_IMAGE_TYPES.includes(mimeType)
    ? "image"
    : mimeType.startsWith("video/") && PLAYABLE_MEDIA_TYPES.includes(mimeType)
      ? "video"
      : "file";

/** Video and audio dx plays in the chat. */
export const attachmentPlayable = (mimeType: string) =>
  PLAYABLE_MEDIA_TYPES.includes(mimeType);

/** "JPG", "MP4", "PDF": the label under a preview's file name. */
export const attachmentTypeLabel = (filename: string, mimeType: string) => {
  const extension = filename.includes(".")
    ? filename.split(".").at(-1)
    : undefined;
  const label =
    extension !== undefined && extension.length <= 8
      ? extension
      : (mimeType.split("/").at(-1) ?? "file");
  return label.toUpperCase();
};

export const formatAttachmentSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};
