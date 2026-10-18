import {
  type AttachmentData,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  withMessageAttachments,
} from "@dx/api";
import {
  type AttachmentUpload,
  startAttachmentUpload,
} from "./attachment-upload.js";

export const MAX_ATTACHMENT_COUNT = MAX_ATTACHMENTS_PER_MESSAGE;

/**
 * A file in the composer. It starts uploading to Core as soon as it is
 * added; the message sent later carries only its attachment reference.
 */
export interface PendingAttachment {
  readonly id: string;
  readonly filename: string;
  /** The browser's type for the file, used only to pick its preview. */
  readonly mimeType: string;
  readonly size: number;
  /** A local `blob:` URL for the composer's thumbnail and preview. */
  readonly previewUrl: string;
  readonly disposePreview: () => void;
  readonly upload: AttachmentUpload;
}

const allocatePreview = (file: File) => {
  const { createObjectURL, revokeObjectURL } = URL;
  const previewUrl = createObjectURL(file);
  return {
    previewUrl,
    disposePreview: () => revokeObjectURL(previewUrl),
  };
};

const megabytes = MAX_ATTACHMENT_BYTES / (1024 * 1024);

export function readAttachment(
  file: File,
  upload: (file: File) => AttachmentUpload = startAttachmentUpload,
): PendingAttachment {
  if (file.size === 0) throw new Error(`${file.name || "File"} is empty.`);
  if (file.size > MAX_ATTACHMENT_BYTES)
    throw new Error(
      `${file.name || "File"} is larger than the ${megabytes} MB limit.`,
    );
  return {
    id: crypto.randomUUID(),
    filename: file.name || "file",
    mimeType: file.type,
    size: file.size,
    ...allocatePreview(file),
    upload: upload(file),
  };
}

/** Revoke the local previews; uploads that were sent stay in the Thread. */
export const disposeAttachments = (
  attachments: ReadonlyArray<PendingAttachment>,
) => {
  for (const attachment of attachments) attachment.disposePreview();
};

/** Drop unsent files: revoke previews and delete their uploads. */
export const discardAttachments = (
  attachments: ReadonlyArray<PendingAttachment>,
) => {
  for (const attachment of attachments) {
    attachment.disposePreview();
    attachment.upload.cancel();
  }
};

export const attachmentsUploading = (
  attachments: ReadonlyArray<PendingAttachment>,
) =>
  attachments.some(({ upload }) => upload.getSnapshot().status === "uploading");

/**
 * The message as sent: the text followed by the `<dx_attachments>` block
 * naming every uploaded file. Waits for uploads still in flight and fails
 * with the first upload's error.
 */
export const messageWithAttachments = async (
  message: string,
  attachments: ReadonlyArray<PendingAttachment>,
) => {
  const uploaded: AttachmentData[] = await Promise.all(
    attachments.map(({ upload }) => upload.settled),
  );
  return withMessageAttachments(
    message,
    uploaded.map(({ id, filename, mimeType, size, url }) => ({
      id,
      name: filename,
      mimeType,
      size,
      url,
    })),
  );
};

/** Files pasted into a text field, such as a copied screenshot. */
export const pastedFiles = (event: {
  readonly clipboardData: DataTransfer | null;
}) => [...(event.clipboardData?.files ?? [])];

export interface PendingAttachmentCollection {
  readonly addFiles: (
    files: ReadonlyArray<File>,
  ) => Promise<ReadonlyArray<PendingAttachment>>;
  readonly addImage: (
    attachment: PendingAttachment,
  ) => ReadonlyArray<PendingAttachment>;
  readonly addGenerated: (
    create: () => Promise<File>,
  ) => Promise<ReadonlyArray<PendingAttachment>>;
  readonly remove: (id: string) => ReadonlyArray<PendingAttachment>;
  readonly list: () => ReadonlyArray<PendingAttachment>;
  readonly take: () => ReadonlyArray<PendingAttachment>;
  readonly restore: (
    attachments: ReadonlyArray<PendingAttachment>,
  ) => ReadonlyArray<PendingAttachment>;
  readonly settle: () => Promise<void>;
  readonly dispose: () => void;
}

export const createPendingAttachmentCollection = (
  upload: (file: File) => AttachmentUpload = startAttachmentUpload,
): PendingAttachmentCollection => {
  let attachments: ReadonlyArray<PendingAttachment> = [];
  let queue: Promise<void> = Promise.resolve();

  const append = (files: ReadonlyArray<File>) => {
    if (attachments.length + files.length > MAX_ATTACHMENT_COUNT)
      throw new Error(`Attach no more than ${MAX_ATTACHMENT_COUNT} files.`);
    const read: PendingAttachment[] = [];
    try {
      for (const file of files) read.push(readAttachment(file, upload));
    } catch (cause) {
      discardAttachments(read);
      throw cause;
    }
    attachments = [...attachments, ...read];
    return attachments;
  };
  const enqueue = <A>(operation: () => Promise<A>) => {
    const result = queue.then(operation);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  return {
    addFiles: (files) => enqueue(async () => append(files)),
    addImage: (attachment) => {
      if (attachments.length >= MAX_ATTACHMENT_COUNT) {
        discardAttachments([attachment]);
        throw new Error(`Attach no more than ${MAX_ATTACHMENT_COUNT} files.`);
      }
      attachments = [...attachments, attachment];
      return attachments;
    },
    addGenerated: (create) =>
      enqueue(async () => {
        if (attachments.length >= MAX_ATTACHMENT_COUNT)
          throw new Error(`Attach no more than ${MAX_ATTACHMENT_COUNT} files.`);
        return append([await create()]);
      }),
    remove: (id) => {
      const removed = attachments.find((attachment) => attachment.id === id);
      if (removed !== undefined) discardAttachments([removed]);
      attachments = attachments.filter((attachment) => attachment.id !== id);
      return attachments;
    },
    list: () => attachments,
    take: () => {
      const taken = attachments;
      attachments = [];
      return taken;
    },
    restore: (restored) => {
      attachments = restored;
      return attachments;
    },
    settle: () => queue,
    dispose: () => {
      discardAttachments(attachments);
      attachments = [];
    },
  };
};

export async function captureScreenshot(): Promise<File> {
  if (navigator.mediaDevices?.getDisplayMedia === undefined)
    throw new Error("Screenshot capture is not supported by this browser.");
  let stream: MediaStream | undefined;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    const track = stream.getVideoTracks()[0];
    if (track === undefined) throw new Error("No screen was selected.");
    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    await video.play();
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
    if (cause instanceof DOMException && cause.name === "NotAllowedError")
      throw new Error("Screenshot capture was cancelled or denied.");
    throw cause instanceof Error
      ? cause
      : new Error("The screenshot could not be captured.");
  } finally {
    for (const track of stream?.getTracks() ?? []) track.stop();
  }
}
