import { parseThreadStorageUrl } from "@dx/api";
import type { MarkdownMediaSource } from "./markdown-file-link-context.js";

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
const VIDEO_EXTENSIONS = new Set([
  "mp4",
  "m4v",
  "webm",
  "mov",
  "ogv",
  "mkv",
  "avi",
  "mpeg",
  "mpg",
  "3gp",
]);
const AUDIO_EXTENSIONS = new Set([
  "mp3",
  "wav",
  "ogg",
  "oga",
  "opus",
  "m4a",
  "aac",
  "flac",
  "weba",
  "aif",
  "aiff",
]);

/**
 * How a file is shown when it is opened. Media and PDFs stream from the
 * sandbox; every other file opens as text.
 */
export type FileMediaKind = "image" | "video" | "audio" | "pdf";

export const fileMediaKind = (path: string): FileMediaKind | undefined => {
  const extension = path.split("/").at(-1)?.split(".").at(-1)?.toLowerCase();
  if (extension === undefined) return undefined;
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (VIDEO_EXTENSIONS.has(extension)) return "video";
  if (AUDIO_EXTENSIONS.has(extension)) return "audio";
  if (extension === "pdf") return "pdf";
  return undefined;
};

/**
 * A file in Thread storage named by a Markdown image, as a same-origin player
 * source: `![alt](https://<dx>/v1/threads/<id>/storage/<file>/shot.png)`, on
 * this origin only. It needs no workspace, so it shows on archived Threads,
 * for shared readers, and after the Orb is gone.
 */
export const storedMediaSource = (
  src: string,
  origin: string = typeof window === "undefined"
    ? "https://dx.invalid"
    : window.location.origin,
): MarkdownMediaSource | undefined => {
  const stored = parseThreadStorageUrl(src.trim(), origin);
  const kind = stored === undefined ? undefined : fileMediaKind(stored.name);
  return stored === undefined || kind === undefined || kind === "pdf"
    ? undefined
    : { url: stored.path, kind, downloadUrl: `${stored.path}?download=1` };
};
