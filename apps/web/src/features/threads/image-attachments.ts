import {
  createPendingAttachmentCollection as createClientCollection,
  type PendingAttachment,
  type PendingAttachmentCollection,
  type PendingAttachmentPlatform,
  readAttachment as readClientAttachment,
} from "@dx/client";
import {
  type AttachmentUpload,
  startAttachmentUpload,
} from "./attachment-upload.js";

export {
  discardAttachments,
  disposeAttachments,
  MAX_ATTACHMENT_COUNT,
  type PendingAttachment,
  type PendingAttachmentCollection,
} from "@dx/client";

/**
 * The browser's side of the composer's files: `blob:` previews, uploads over
 * XMLHttpRequest, screenshots, and pasted files. The collection itself is
 * `pending-attachments.ts` in `@dx/client`.
 */

const allocatePreview = (file: File) => {
  const { createObjectURL, revokeObjectURL } = URL;
  const previewUrl = createObjectURL(file);
  return {
    previewUrl,
    disposePreview: () => revokeObjectURL(previewUrl),
  };
};

const browserFiles = (
  upload: (file: File) => AttachmentUpload,
): PendingAttachmentPlatform => ({
  // A browser's pending files are Files: the collection hands back what it was given.
  upload: (file) => upload(file as File),
  preview: (file) => allocatePreview(file as File),
  newId: () => crypto.randomUUID(),
});

export const readAttachment = (
  file: File,
  upload: (file: File) => AttachmentUpload = startAttachmentUpload,
): PendingAttachment => readClientAttachment(file, browserFiles(upload));

export const createPendingAttachmentCollection = (
  upload: (file: File) => AttachmentUpload = startAttachmentUpload,
) => createClientCollection(browserFiles(upload));

/** Files pasted into a text field, such as a copied screenshot. */
export const pastedFiles = (event: {
  readonly clipboardData: DataTransfer | null;
}) => [...(event.clipboardData?.files ?? [])];

/** Waits for the first frame, so a stream that never plays still ends. */
const firstFrame = async (video: HTMLVideoElement) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      video.play(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("The selected screen could not be captured.")),
          5_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * One frame of a screen, window, or tab the person picks. Call it directly
 * from their tap: browsers allow `getDisplayMedia` only during a user
 * gesture. Resolves `undefined` when they close the picker without choosing.
 */
export async function captureScreenshot(): Promise<File | undefined> {
  if (navigator.mediaDevices?.getDisplayMedia === undefined)
    throw new Error("Screenshot capture is not supported by this browser.");
  let stream: MediaStream | undefined;
  let video: HTMLVideoElement | undefined;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    const track = stream.getVideoTracks()[0];
    if (track === undefined) throw new Error("No screen was selected.");
    video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await firstFrame(video);
    if (video.videoWidth === 0 || video.videoHeight === 0)
      throw new Error("The selected screen could not be captured.");
    const scale = Math.min(
      1,
      1920 / video.videoWidth,
      1080 / video.videoHeight,
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    canvas
      .getContext("2d")
      ?.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (value) =>
          value === null
            ? reject(new Error("The screenshot could not be encoded."))
            : resolve(value),
        "image/png",
      ),
    );
    return new File([blob], `Screenshot ${new Date().toISOString()}.png`, {
      type: "image/png",
      lastModified: Date.now(),
    });
  } catch (cause) {
    // Closing the picker rejects with NotAllowedError (AbortError in some
    // browsers): the person chose not to share, which is not an error.
    if (
      cause instanceof DOMException &&
      (cause.name === "NotAllowedError" || cause.name === "AbortError")
    )
      return undefined;
    throw cause instanceof Error
      ? cause
      : new Error("The screenshot could not be captured.");
  } finally {
    if (video !== undefined) video.srcObject = null;
    for (const track of stream?.getTracks() ?? []) track.stop();
  }
}

/**
 * Adds a screenshot of the screen the person picks; call it from their tap.
 *
 * Never rejects, and composers must not report its outcome. A screenshot
 * that is not captured is not an error to the person: they closed the
 * picker, denied access, picked a source that would not start, or use a
 * browser without screen capture. Do not show an error card, notice, or
 * toast for it; the person can simply try again. Resolves the files as they
 * now stand.
 */
export const addScreenshot = (
  collection: PendingAttachmentCollection,
): Promise<ReadonlyArray<PendingAttachment>> =>
  collection.addGenerated(captureScreenshot).catch((cause: unknown) => {
    console.warn("Screenshot not captured:", cause);
    return collection.list();
  });
