import { type AttachmentData, withMessageAttachments } from "@dx/api";

/** A file in the composer, as far as a send reads it: its upload. */
export interface SendingAttachment {
  readonly upload: {
    readonly getSnapshot: () => { readonly status: string };
    readonly settled: Promise<AttachmentData>;
  };
}

/** Whether any file is still uploading, which holds Send back. */
export const attachmentsUploading = (
  attachments: ReadonlyArray<SendingAttachment>,
) =>
  attachments.some(({ upload }) => upload.getSnapshot().status === "uploading");

/**
 * The message as sent: the text followed by the `<dx_attachments>` block
 * naming every uploaded file. Waits for uploads still in flight and fails
 * with the first upload's error.
 */
export const messageWithAttachments = async (
  message: string,
  attachments: ReadonlyArray<SendingAttachment>,
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
