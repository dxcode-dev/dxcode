import type { AttachmentPartResponse } from "@dx/api";
import {
  type AttachmentUpload,
  startAttachmentUpload as startClientUpload,
} from "@dx/client";

export type { AttachmentUpload, AttachmentUploadState } from "@dx/client";

/**
 * PUT one part with upload progress, which fetch cannot report. The URL is a
 * presigned R2 URL in every stage, so the bytes go straight to storage; the
 * part is named by the response's `ETag` header.
 */
const putPart = (
  url: string,
  partNumber: number,
  body: Blob,
  signal: AbortSignal,
  onProgress: (loaded: number) => void,
) =>
  new Promise<AttachmentPartResponse>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", url);
    request.upload.onprogress = (event) => onProgress(event.loaded);
    request.onload = () => {
      const etag = request.getResponseHeader("etag");
      if (request.status >= 200 && request.status < 300 && etag)
        resolve({ partNumber, etag });
      else reject(new Error("The upload failed."));
    };
    request.onerror = () => reject(new Error("The upload was interrupted."));
    request.onabort = () => reject(new DOMException("Aborted", "AbortError"));
    const abort = () => request.abort();
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    request.send(body);
  });

/** Start uploading `file` now; the composer shows its progress. */
export const startAttachmentUpload = (file: File): AttachmentUpload =>
  startClientUpload(file, {
    // The attachment endpoints load with the first upload, so the Thread
    // page's first load does not carry them.
    requests: () =>
      import("./attachment-upload-mutations.js").then(
        ({ attachmentUploadRequests }) => attachmentUploadRequests,
      ),
    putPart,
  });
