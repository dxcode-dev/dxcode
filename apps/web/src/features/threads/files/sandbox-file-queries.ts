import {
  THREAD_SANDBOX_FILE_MAX_PREVIEW_BYTES,
  type ThreadSandboxFilePath,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { queryOptions } from "@tanstack/react-query";
import { sameOriginFetch } from "../../../shared/same-origin-fetch.js";
import { sandboxFileUrl } from "../transcript-file-link.js";
import { threadFilesKeys } from "./files-queries.js";

/** Text above this size is offered for download rather than rendered. */
export const SANDBOX_TEXT_PREVIEW_MAX_BYTES = 1_024 * 1_024;

export type SandboxFilePreview =
  | {
      readonly kind: "text";
      readonly content: string;
      readonly sizeBytes: number;
    }
  | {
      readonly kind: "download";
      readonly reason: "binary" | "too-large";
      readonly sizeBytes: number;
    };

export class SandboxFileError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "SandboxFileError";
  }
}

const failure = (status: number) =>
  new SandboxFileError(
    status,
    status === 404
      ? "This file no longer exists in the sandbox."
      : status === 400
        ? "This file cannot be opened."
        : status === 409
          ? "The file changed while it was loading. Retry to load it again."
          : "The sandbox is temporarily unavailable.",
  );

/**
 * Probe a non-media sandbox file, then fetch its text when it is small
 * enough to render. The server labels every non-media file as plain text or
 * opaque bytes, so the content type decides text versus download.
 */
export const fetchSandboxFilePreview = async (
  threadId: ThreadId,
  path: ThreadSandboxFilePath,
  signal?: AbortSignal,
  fetcher: typeof fetch = sameOriginFetch,
): Promise<SandboxFilePreview> => {
  const { sizeBytes } = await fetchSandboxFileMetadata(
    threadId,
    path,
    signal,
    fetcher,
  );
  if (sizeBytes > SANDBOX_TEXT_PREVIEW_MAX_BYTES)
    return { kind: "download", reason: "too-large", sizeBytes };
  const response = await fetcher(
    sandboxFileUrl(threadId, path),
    signal === undefined ? {} : { signal },
  );
  if (!response.ok) throw failure(response.status);
  if (!response.headers.get("content-type")?.startsWith("text/plain"))
    return { kind: "download", reason: "binary", sizeBytes };
  // The server sniffs only the first chunk; decode strictly so binary bytes
  // later in the file become a download instead of replacement characters.
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.includes(0))
    return { kind: "download", reason: "binary", sizeBytes };
  try {
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { kind: "text", content, sizeBytes };
  } catch {
    return { kind: "download", reason: "binary", sizeBytes };
  }
};

export const sandboxFilePreviewOptions = (
  threadId: ThreadId,
  path: ThreadSandboxFilePath,
  active = true,
) =>
  queryOptions({
    queryKey: [...threadFilesKeys.all(threadId), "sandbox", path] as const,
    queryFn: ({ signal }) => fetchSandboxFilePreview(threadId, path, signal),
    enabled: active,
    staleTime: 1_000,
    retry: (count, error) =>
      count < 2 && !(error instanceof SandboxFileError && error.status < 500),
    retryDelay: (attempt) => 250 * 2 ** attempt,
    refetchOnReconnect: "always",
    refetchOnWindowFocus: "always",
  });

export interface SandboxFileMetadata {
  readonly sizeBytes: number;
  readonly mediaType: string;
}

/** HEAD the download form, which is never refused for size. */
export const fetchSandboxFileMetadata = async (
  threadId: ThreadId,
  path: ThreadSandboxFilePath,
  signal?: AbortSignal,
  fetcher: typeof fetch = sameOriginFetch,
): Promise<SandboxFileMetadata> => {
  const head = await fetcher(sandboxFileUrl(threadId, path, true), {
    method: "HEAD",
    ...(signal === undefined ? {} : { signal }),
  });
  if (!head.ok) throw failure(head.status);
  return {
    sizeBytes: Number(head.headers.get("content-length") ?? "0"),
    mediaType: head.headers.get("content-type") ?? "application/octet-stream",
  };
};

export const sandboxFileMetadataOptions = (
  threadId: ThreadId,
  path: ThreadSandboxFilePath,
  active = true,
) =>
  queryOptions({
    queryKey: [...threadFilesKeys.all(threadId), "sandbox-head", path] as const,
    queryFn: ({ signal }) => fetchSandboxFileMetadata(threadId, path, signal),
    enabled: active,
    staleTime: 1_000,
    retry: (count, error) =>
      count < 2 && !(error instanceof SandboxFileError && error.status < 500),
    retryDelay: (attempt) => 250 * 2 ** attempt,
    refetchOnReconnect: "always",
    refetchOnWindowFocus: "always",
  });

export const formatBytes = (bytes: number) => {
  if (bytes < 1_024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1_024;
  let unit = 0;
  while (value >= 1_024 && unit < units.length - 1) {
    value /= 1_024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
};

export const exceedsPreviewLimit = (sizeBytes: number) =>
  sizeBytes > THREAD_SANDBOX_FILE_MAX_PREVIEW_BYTES;
