import type {
  AttachmentData,
  AttachmentPartResponse,
  CreateAttachmentResponse,
} from "@dx/api";

/**
 * One file's upload to Core: Core names where each part goes, the parts go
 * straight to storage a few at a time, and Core joins them. An external store
 * the composer subscribes to for its progress. The UI passes how a part is
 * sent (a browser uses XMLHttpRequest for upload progress) and the requests,
 * which it may load on first use.
 */

/** Parts sent at once. Each part is one request of at most 10 MiB. */
const PART_CONCURRENCY = 3;

export type AttachmentUploadState =
  | { readonly status: "uploading"; readonly loaded: number }
  | { readonly status: "ready"; readonly attachment: AttachmentData }
  | { readonly status: "failed"; readonly error: string };

export interface AttachmentUpload {
  readonly getSnapshot: () => AttachmentUploadState;
  readonly subscribe: (listener: () => void) => () => void;
  /** Resolves with the stored attachment. */
  readonly settled: Promise<AttachmentData>;
  /** Stop the upload and delete whatever Core stored; unsent files only. */
  readonly cancel: () => void;
}

/** A file to upload: a browser `File`, or any blob with a name. */
export interface UploadFile {
  readonly name: string;
  readonly type: string;
  readonly size: number;
  slice(start?: number, end?: number): Blob;
}

/** Core's attachment calls. Each failure throws an Error with its message. */
export interface AttachmentRequests {
  readonly create: (
    file: UploadFile,
    signal: AbortSignal,
  ) => Promise<CreateAttachmentResponse>;
  readonly complete: (
    id: string,
    parts: ReadonlyArray<AttachmentPartResponse>,
    signal: AbortSignal,
  ) => Promise<AttachmentData>;
  readonly remove: (id: string) => Promise<void>;
}

/**
 * Sends one part to its presigned storage URL, reports its bytes as they go,
 * and resolves with the part's ETag. Rejects with an AbortError on `signal`.
 */
export type PutAttachmentPart = (
  url: string,
  partNumber: number,
  body: Blob,
  signal: AbortSignal,
  onProgress: (loaded: number) => void,
) => Promise<AttachmentPartResponse>;

export interface AttachmentUploadPlatform {
  /** The requests, loaded on the first upload. */
  readonly requests: () => Promise<AttachmentRequests>;
  readonly putPart: PutAttachmentPart;
}

const upload = async (
  file: UploadFile,
  platform: AttachmentUploadPlatform,
  signal: AbortSignal,
  onCreated: (id: string) => void,
  onProgress: (loaded: number) => void,
): Promise<AttachmentData> => {
  const requests = await platform.requests();
  const created = await requests.create(file, signal);
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
      const part = await platform
        .putPart(
          target.url,
          target.partNumber,
          file.slice(start, Math.min(file.size, start + created.partSize)),
          partSignal,
          (bytes) => {
            loaded[target.partNumber - 1] = bytes;
            report();
          },
        )
        .catch((cause: unknown) => {
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
  return requests.complete(
    created.id,
    parts.sort((left, right) => left.partNumber - right.partNumber),
    signal,
  );
};

/** Start uploading `file` now; the composer shows its progress. */
export const startAttachmentUpload = (
  file: UploadFile,
  platform: AttachmentUploadPlatform,
): AttachmentUpload => {
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
    platform,
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
        void platform
          .requests()
          .then((requests) => requests.remove(id))
          .catch(() => undefined);
    },
  };
};
