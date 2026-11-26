import {
  GetThreadFileEndpoint,
  GetThreadFileTreeEndpoint,
  SaveThreadFileEndpoint,
  type ThreadFileData,
  type ThreadFilesCursor,
  type ThreadFilesPath,
  type ThreadFilesWorktreeId,
  type ThreadFileTreeData,
  type ThreadFileVersion,
  UploadThreadFileEndpoint,
  WriteThreadFilesEndpoint,
  type WriteThreadFilesRequest,
} from "@dx/api";
import { ApiError, createDxClient } from "@dx/client";
import type { ThreadId } from "@dx/domain";
import { Schema } from "effect";
import { sameOriginFetch } from "../../../shared/same-origin-fetch.js";

export class ThreadFilesApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "ThreadFilesApiError";
  }
}

type Fetcher = typeof sameOriginFetch;

/**
 * Runs one Files call as a ThreadFilesApiError: the route's own code and
 * message for an error it sends on purpose, else a generic one.
 */
const filesCall = async <A>(run: () => Promise<A>): Promise<A> => {
  try {
    return await run();
  } catch (cause) {
    if (cause instanceof ApiError) {
      const requestId = cause.data?.requestId;
      throw new ThreadFilesApiError(
        cause.status,
        cause.code ?? "THREAD_FILES_UNAVAILABLE",
        cause.hasValidatedPayload ? cause.message : "Files request failed.",
        typeof requestId === "string" ? requestId : undefined,
      );
    }
    if (Schema.isSchemaError(cause))
      throw new ThreadFilesApiError(
        200,
        "THREAD_FILES_INVALID_RESPONSE",
        "Files returned an invalid response.",
      );
    throw cause;
  }
};

export interface ThreadFilesApi {
  readonly list: (
    threadId: ThreadId,
    path: ThreadFilesPath | undefined,
    cursor: ThreadFilesCursor | undefined,
    worktree: ThreadFilesWorktreeId | undefined,
    signal?: AbortSignal,
    /** The root may come from the Orb's last listing while it wakes. */
    allowSnapshot?: boolean,
  ) => Promise<ThreadFileTreeData>;
  readonly read: (
    threadId: ThreadId,
    path: ThreadFilesPath,
    worktree: ThreadFilesWorktreeId | undefined,
    signal?: AbortSignal,
  ) => Promise<ThreadFileData>;
  readonly save: (
    threadId: ThreadId,
    path: ThreadFilesPath,
    input: {
      readonly content: string;
      readonly expectedVersion: ThreadFileVersion;
      readonly worktree?: ThreadFilesWorktreeId;
    },
  ) => Promise<{
    readonly kind: "saved";
    readonly contentVersion: ThreadFileVersion;
  }>;
  /**
   * Create, move, copy, or delete; never replaces an existing entry. A
   * transport without writes (a read-only demo) offers no write actions.
   */
  readonly write?: (
    threadId: ThreadId,
    request: WriteThreadFilesRequest,
    worktree: ThreadFilesWorktreeId | undefined,
  ) => Promise<{ readonly kind: "changed" }>;
  /** A new file with these bytes; never replaces an existing one. */
  readonly upload?: (
    threadId: ThreadId,
    path: ThreadFilesPath,
    file: Blob,
    worktree: ThreadFilesWorktreeId | undefined,
  ) => Promise<{ readonly kind: "changed" }>;
}

export const createThreadFilesApi = (
  fetcher: Fetcher = sameOriginFetch,
): ThreadFilesApi => {
  const client = createDxClient({
    fetch: (path, init) =>
      fetcher(path, { ...init, credentials: "same-origin" }),
  });
  return {
    list: async (threadId, path, cursor, worktree, signal, allowSnapshot) => {
      const response = await filesCall(() =>
        client.call(
          GetThreadFileTreeEndpoint,
          {
            params: { threadId },
            query: {
              ...(worktree === undefined ? {} : { worktree }),
              ...(path === undefined ? {} : { path }),
              ...(cursor === undefined ? {} : { cursor }),
              ...(allowSnapshot === true ? { snapshot: "allow" as const } : {}),
            },
          },
          signal === undefined ? {} : { signal },
        ),
      );
      return response.data;
    },
    read: async (threadId, path, worktree, signal) => {
      const response = await filesCall(() =>
        client.call(
          GetThreadFileEndpoint,
          {
            params: { threadId, path },
            query: worktree === undefined ? {} : { worktree },
          },
          signal === undefined ? {} : { signal },
        ),
      );
      return response.data;
    },
    save: async (threadId, path, input) => {
      const response = await filesCall(() =>
        client.call(SaveThreadFileEndpoint, {
          params: { threadId, path },
          query:
            input.worktree === undefined ? {} : { worktree: input.worktree },
          body: {
            content: input.content,
            expectedVersion: input.expectedVersion,
          },
        }),
      );
      return response.data;
    },
    write: async (threadId, body, worktree) => {
      const response = await filesCall(() =>
        client.call(WriteThreadFilesEndpoint, {
          params: { threadId },
          query: worktree === undefined ? {} : { worktree },
          body,
        }),
      );
      return response.data;
    },
    upload: async (threadId, path, file, worktree) => {
      const response = await filesCall(() =>
        client.call(
          UploadThreadFileEndpoint,
          {
            params: { threadId, path },
            query: worktree === undefined ? {} : { worktree },
            body: file,
          },
          // The bytes as they are, whatever the file's own type.
          { headers: { "content-type": "application/octet-stream" } },
        ),
      );
      return response.data;
    },
  };
};
