import {
  GetThreadFileResponseSchema,
  GetThreadFileTreeResponseSchema,
  SaveThreadFileResponseSchema,
  type ThreadFileData,
  type ThreadFilesCursor,
  type ThreadFilesPath,
  type ThreadFilesWorktreeId,
  type ThreadFileTreeData,
  type ThreadFileVersion,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { Schema } from "effect";
import { sameOriginFetch } from "../../../shared/same-origin-fetch.js";

const ErrorResponseSchema = Schema.Struct({
  status: Schema.Literal("error"),
  data: Schema.Struct({
    code: Schema.String,
    message: Schema.String,
    requestId: Schema.String,
  }),
});

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

const baseUrl = (threadId: ThreadId) =>
  `/v1/threads/${encodeURIComponent(threadId)}/files`;

const request = async <S extends Schema.ConstraintDecoder<unknown>>(
  fetcher: Fetcher,
  url: string,
  schema: S,
  init: RequestInit = {},
): Promise<S["Type"]> => {
  const response = await fetcher(url, {
    credentials: "same-origin",
    ...init,
    headers: {
      accept: "application/json",
      ...(init.body === undefined
        ? {}
        : { "content-type": "application/json" }),
      ...init.headers,
    },
  });
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = await Schema.decodeUnknownPromise(ErrorResponseSchema)(
      body,
    ).catch(() => undefined);
    throw new ThreadFilesApiError(
      response.status,
      error?.data.code ?? "THREAD_FILES_UNAVAILABLE",
      error?.data.message ?? "Files request failed.",
      error?.data.requestId,
    );
  }
  try {
    return await Schema.decodeUnknownPromise(schema)(body);
  } catch {
    throw new ThreadFilesApiError(
      response.status,
      "THREAD_FILES_INVALID_RESPONSE",
      "Files returned an invalid response.",
    );
  }
};

export interface ThreadFilesApi {
  readonly list: (
    threadId: ThreadId,
    path: ThreadFilesPath | undefined,
    cursor: ThreadFilesCursor | undefined,
    worktree: ThreadFilesWorktreeId | undefined,
    signal?: AbortSignal,
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
}

export const createThreadFilesApi = (
  fetcher: Fetcher = sameOriginFetch,
): ThreadFilesApi => ({
  list: async (threadId, path, cursor, worktree, signal) => {
    const query = new URLSearchParams();
    if (worktree !== undefined) query.set("worktree", worktree);
    if (path !== undefined) query.set("path", path);
    if (cursor !== undefined) query.set("cursor", cursor);
    const response = await request(
      fetcher,
      `${baseUrl(threadId)}${query.size === 0 ? "" : `?${query}`}`,
      GetThreadFileTreeResponseSchema,
      signal === undefined ? {} : { signal },
    );
    return response.data;
  },
  read: async (threadId, path, worktree, signal) => {
    const query = new URLSearchParams();
    if (worktree !== undefined) query.set("worktree", worktree);
    const response = await request(
      fetcher,
      `${baseUrl(threadId)}/${encodeURIComponent(path)}${query.size === 0 ? "" : `?${query}`}`,
      GetThreadFileResponseSchema,
      signal === undefined ? {} : { signal },
    );
    return response.data;
  },
  save: async (threadId, path, input) => {
    const query = new URLSearchParams();
    if (input.worktree !== undefined) query.set("worktree", input.worktree);
    const response = await request(
      fetcher,
      `${baseUrl(threadId)}/${encodeURIComponent(path)}${query.size === 0 ? "" : `?${query}`}`,
      SaveThreadFileResponseSchema,
      {
        method: "PATCH",
        body: JSON.stringify({
          content: input.content,
          expectedVersion: input.expectedVersion,
        }),
      },
    );
    return response.data;
  },
});
