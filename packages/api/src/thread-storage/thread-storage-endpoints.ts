import { ThreadId } from "@dx/domain";
import { Schema } from "effect";
import { defineEndpoint, FileAnswerSchema } from "../http/endpoint.js";
import { errorResponse } from "../http/response.js";
import { ThreadAccessRefusals } from "../threads/thread-access-refusals.js";
import {
  ThreadStorageFileIdSchema,
  ThreadStorageListResponseSchema,
} from "./index.js";

/**
 * Reading a Thread's storage, apart from the schemas in `index.ts`, which the
 * transcript loads to recognize a stored file's URL. Only the Thread's own
 * dxd writes, through the daemon ingress, so there is no write endpoint.
 */

/** 404: no ready file with that ID belongs to the Thread. */
export const ThreadStorageFileNotFoundResponseSchema = errorResponse(
  "THREAD_STORAGE_FILE_NOT_FOUND",
  "File not found.",
);
/** 503: the deployment has no database or storage for Thread files. */
export const ThreadStorageUnavailableResponseSchema = errorResponse(
  "THREAD_STORAGE_UNAVAILABLE",
  "Thread storage is unavailable.",
);
/** 503: the database or storage failed while handling the request. */
export const ThreadStorageRequestFailedResponseSchema = errorResponse(
  "THREAD_STORAGE_REQUEST_FAILED",
  "The storage request failed.",
);

export const ThreadStorageErrorResponseSchema = Schema.Union([
  ThreadStorageFileNotFoundResponseSchema,
  ThreadStorageUnavailableResponseSchema,
  ThreadStorageRequestFailedResponseSchema,
]);
export type ThreadStorageErrorResponse =
  typeof ThreadStorageErrorResponseSchema.Type;

const storageRefusals = [
  ...ThreadAccessRefusals,
  { status: 503, schema: ThreadStorageUnavailableResponseSchema },
  { status: 503, schema: ThreadStorageRequestFailedResponseSchema },
] as const;

export const ThreadStorageParamsSchema = Schema.Struct({ threadId: ThreadId });

/** The finished, lasting files, newest first, at most 200. */
export const ListThreadStorageFilesEndpoint = defineEndpoint({
  id: "threads.storage.list",
  summary: "List the files a Thread keeps in dx",
  method: "GET",
  path: "/v1/threads/:threadId/storage",
  params: ThreadStorageParamsSchema,
  success: ThreadStorageListResponseSchema,
  refusals: storageRefusals,
});

/** `?download=1` asks for the file as a download rather than inline. */
export const ThreadStorageFileQuerySchema = Schema.Struct({
  download: Schema.optional(Schema.Literal("1")),
});

/**
 * A stored file's bytes: a redirect to a short-lived storage URL, for an
 * `<img src>` or a download link built with `endpointPath`. A View member
 * is refused the work a read-only restart rescued (403 `THREAD_READ_ONLY`).
 */
export const GetThreadStorageFileEndpoint = defineEndpoint({
  id: "threads.storage.file",
  summary: "Download a file a Thread keeps in dx",
  method: "GET",
  path: "/v1/threads/:threadId/storage/:fileId",
  params: Schema.Struct({
    threadId: ThreadId,
    fileId: ThreadStorageFileIdSchema,
  }),
  query: ThreadStorageFileQuerySchema,
  success: FileAnswerSchema,
  answer: "file",
  refusals: [
    ...storageRefusals,
    { status: 404, schema: ThreadStorageFileNotFoundResponseSchema },
  ],
});

/** The same bytes under the file's name, as `threadStoragePath` links to it. */
export const GetNamedThreadStorageFileEndpoint = defineEndpoint({
  id: "threads.storage.namedFile",
  summary: "Download a file a Thread keeps in dx under its file name",
  method: "GET",
  path: "/v1/threads/:threadId/storage/:fileId/:name",
  params: Schema.Struct({
    threadId: ThreadId,
    fileId: ThreadStorageFileIdSchema,
    name: Schema.String,
  }),
  query: ThreadStorageFileQuerySchema,
  success: FileAnswerSchema,
  answer: "file",
  refusals: [
    ...storageRefusals,
    { status: 404, schema: ThreadStorageFileNotFoundResponseSchema },
  ],
});
