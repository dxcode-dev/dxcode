import { Schema } from "effect";
import { defineEndpoint, FileAnswerSchema } from "../http/endpoint.js";
import {
  ThreadFilesConflictResponseSchema,
  ThreadFilesEntryNotFoundResponseSchema,
  ThreadFilesInvalidRequestResponseSchema,
  ThreadFilesParamsSchema,
  ThreadFilesUnavailableResponseSchema,
  ThreadSandboxFilePath,
  ThreadSandboxFilePreviewTooLargeResponseSchema,
} from "./files.js";
import {
  ThreadAccessRefusals,
  ThreadActiveRefusals,
} from "./thread-access-refusals.js";

/**
 * A sandbox file's link, apart from the other Files endpoints: transcript
 * links build it on the Thread page's first load.
 */

/** What every Files route refuses: they run in the Orb of an active Thread. */
export const ThreadFilesRefusals = [
  ...ThreadAccessRefusals,
  ...ThreadActiveRefusals,
  { status: 400, schema: ThreadFilesInvalidRequestResponseSchema },
  { status: 404, schema: ThreadFilesEntryNotFoundResponseSchema },
  { status: 409, schema: ThreadFilesConflictResponseSchema },
  { status: 503, schema: ThreadFilesUnavailableResponseSchema },
] as const;

export const ThreadSandboxFileQuerySchema = Schema.Struct({
  path: ThreadSandboxFilePath,
  download: Schema.optional(Schema.Literal("1")),
});

/**
 * Any file in the Thread's sandbox, streamed (ranges included) for an
 * `<img>`, `<video>`, or download link built with `endpointPath`.
 */
export const GetThreadSandboxFileEndpoint = defineEndpoint({
  id: "threads.files.sandboxFile",
  summary: "Open an Orb file the transcript links to",
  method: "GET",
  path: "/v1/threads/:threadId/files-sandbox",
  params: ThreadFilesParamsSchema,
  query: ThreadSandboxFileQuerySchema,
  success: FileAnswerSchema,
  answer: "file",
  refusals: [
    ...ThreadFilesRefusals,
    { status: 413, schema: ThreadSandboxFilePreviewTooLargeResponseSchema },
  ],
});
