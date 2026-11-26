import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_MESSAGE } from "@dx/api";
import type { AttachmentUpload, UploadFile } from "./attachment-upload.js";

/**
 * The files in a composer before they are sent: each starts uploading when
 * added, a message takes them, and a failed send restores them. Additions
 * run one at a time, so the ten-file limit holds across concurrent picks.
 */

export const MAX_ATTACHMENT_COUNT = MAX_ATTACHMENTS_PER_MESSAGE;

/** What a UI supplies for each file: its upload, its preview, and an id. */
export interface PendingAttachmentPlatform {
  readonly upload: (file: UploadFile) => AttachmentUpload;
  /** A local preview, such as a browser's `blob:` URL, and its release. */
  readonly preview: (file: UploadFile) => {
    readonly previewUrl: string;
    readonly disposePreview: () => void;
  };
  readonly newId: () => string;
}

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

const megabytes = MAX_ATTACHMENT_BYTES / (1024 * 1024);

export function readAttachment(
  file: UploadFile,
  platform: PendingAttachmentPlatform,
): PendingAttachment {
  if (file.size === 0) throw new Error(`${file.name || "File"} is empty.`);
  if (file.size > MAX_ATTACHMENT_BYTES)
    throw new Error(
      `${file.name || "File"} is larger than the ${megabytes} MB limit.`,
    );
  return {
    id: platform.newId(),
    filename: file.name || "file",
    mimeType: file.type,
    size: file.size,
    ...platform.preview(file),
    upload: platform.upload(file),
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

export interface PendingAttachmentCollection {
  readonly addFiles: (
    files: ReadonlyArray<UploadFile>,
  ) => Promise<ReadonlyArray<PendingAttachment>>;
  readonly addImage: (
    attachment: PendingAttachment,
  ) => ReadonlyArray<PendingAttachment>;
  /**
   * Starts `create` at once, so a capture that needs the person's tap (such
   * as `getDisplayMedia`) runs inside it. The capture stays outside the
   * queue: one that never settles cannot hold up later files. `undefined`
   * means the person cancelled, and leaves the files unchanged.
   */
  readonly addGenerated: (
    create: () => Promise<UploadFile | undefined>,
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
  platform: PendingAttachmentPlatform,
): PendingAttachmentCollection => {
  let attachments: ReadonlyArray<PendingAttachment> = [];
  let queue: Promise<void> = Promise.resolve();

  const append = (files: ReadonlyArray<UploadFile>) => {
    if (attachments.length + files.length > MAX_ATTACHMENT_COUNT)
      throw new Error(`Attach no more than ${MAX_ATTACHMENT_COUNT} files.`);
    const read: PendingAttachment[] = [];
    try {
      for (const file of files) read.push(readAttachment(file, platform));
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
    addGenerated: (create) => {
      if (attachments.length >= MAX_ATTACHMENT_COUNT)
        return Promise.reject(
          new Error(`Attach no more than ${MAX_ATTACHMENT_COUNT} files.`),
        );
      return create().then((file) =>
        file === undefined ? attachments : enqueue(async () => append([file])),
      );
    },
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
