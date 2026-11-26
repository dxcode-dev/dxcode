import type { AttachmentData, AttachmentPartResponse } from "@dx/api";
import { sameOriginFetch } from "../../shared/same-origin-fetch.js";

/** Parts sent at once. Each part is one request of at most 10 MiB. */
const PART_CONCURRENCY = 3;

export type AttachmentUploadState =
  | { readonly status: "uploading"; readonly loaded: number }
  | { readonly status: "ready"; readonly attachment: AttachmentData }
  | { readonly status: "failed"; readonly error: string };

/**
 * One file's upload to Core, as an external store the composer subscribes
 * to for its progress ring. `settled` resolves with the stored attachment.
 */
export interface AttachmentUpload {
  readonly getSnapshot: () => AttachmentUploadState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly settled: Promise<AttachmentData>;
  /** Stop the upload and delete whatever Core stored; unsent files only. */
  readonly cancel: () => void;
}

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

const upload = async (
  file: File,
  signal: AbortSignal,
  onCreated: (id: string) => void,
  onProgress: (loaded: number) => void,
): Promise<AttachmentData> => {
  const requests = await import("./attachment-upload-mutations.js");
  const created = await requests.createAttachment(file, signal);
  onCreated(created.id);
  const loaded = new Array<number>(created.partCount).fill(0);
  const report = () => onProgress(loaded.reduce((sum, value) => sum + value));
  const parts: AttachmentPartResponse[] = [];
  // One failed part stops the others instead of sending the rest for
  // nothing.
  const failed = new AbortController();
  const partSignal = AbortSignal.any([signal, failed.signal]);
  let next = 0;
  const worker = async () => {
    while (next < created.parts.length) {
      const target = created.parts[next++];
      if (target === undefined) return;
      const start = (target.partNumber - 1) * created.partSize;
      const part = await putPart(
        target.url,
        target.partNumber,
        file.slice(start, Math.min(file.size, start + created.partSize)),
        partSignal,
        (bytes) => {
          loaded[target.partNumber - 1] = bytes;
          report();
        },
      ).catch((cause: unknown) => {
        failed.abort();
        throw cause;
      });
      parts.push(part);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(PART_CONCURRENCY, created.parts.length) },
      () => worker(),
    ),
  );
  return requests.completeAttachment(
    created.id,
    parts.sort((left, right) => left.partNumber - right.partNumber),
    signal,
  );
};

/** Start uploading `file` now; the composer shows its progress. */
export const startAttachmentUpload = (file: File): AttachmentUpload => {
  const controller = new AbortController();
  const listeners = new Set<() => void>();
  let state: AttachmentUploadState = { status: "uploading", loaded: 0 };
  let createdId: string | undefined;
  const set = (next: AttachmentUploadState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const settled = upload(
    file,
    controller.signal,
    (id) => {
      createdId = id;
    },
    (loaded) => {
      if (state.status === "uploading") set({ status: "uploading", loaded });
    },
  ).then(
    (attachment) => {
      set({ status: "ready", attachment });
      return attachment;
    },
    (cause: unknown) => {
      const error =
        controller.signal.aborted ||
        (cause instanceof DOMException && cause.name === "AbortError")
          ? "The upload was cancelled."
          : cause instanceof Error
            ? cause.message
            : "The file could not be uploaded.";
      set({ status: "failed", error });
      throw new Error(`${file.name || "File"}: ${error}`);
    },
  );
  // A failure is reported through the state; callers that await `settled`
  // handle it themselves.
  settled.catch(() => undefined);
  return {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    settled,
    cancel: () => {
      controller.abort();
      const id = createdId;
      if (id !== undefined)
        // Answers 204 without a body, which `dxClient.call` cannot read
        // yet; the route stays legacy until it can.
        void sameOriginFetch(`/v1/attachments/${id}`, {
          method: "DELETE",
        }).catch(() => undefined);
    },
  };
};
