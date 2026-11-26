import { ThreadId } from "@dx/domain";
import { Schema } from "effect";
import { defineEndpoint } from "../http/endpoint.js";
import {
  GetThreadFileResponseSchema,
  GetThreadFileTreeResponseSchema,
  SaveThreadFileRequestSchema,
  SaveThreadFileResponseSchema,
  ThreadFilesCursor,
  ThreadFilesParamsSchema,
  ThreadFilesPath,
  ThreadFilesWorktreeId,
  WriteThreadFilesRequestSchema,
  WriteThreadFilesResponseSchema,
} from "./files.js";
import { ThreadFilesRefusals } from "./files-sandbox-endpoints.js";

/** The Files endpoints, apart from `files.ts`'s schemas. */

/** `snapshot=allow`: the root may come from the Orb's last listing while it wakes. */
export const GetThreadFileTreeQuerySchema = Schema.Struct({
  worktree: Schema.optional(ThreadFilesWorktreeId),
  path: Schema.optional(ThreadFilesPath),
  cursor: Schema.optional(ThreadFilesCursor),
  snapshot: Schema.optional(Schema.Literal("allow")),
});

export const WriteThreadFilesQuerySchema = Schema.Struct({
  worktree: Schema.optional(ThreadFilesWorktreeId),
});

export const GetThreadFileTreeEndpoint = defineEndpoint({
  id: "threads.files.list",
  summary: "List a folder in the Thread's Orb",
  method: "GET",
  path: "/v1/threads/:threadId/files",
  params: ThreadFilesParamsSchema,
  query: GetThreadFileTreeQuerySchema,
  success: GetThreadFileTreeResponseSchema,
  refusals: ThreadFilesRefusals,
});

export const WriteThreadFilesEndpoint = defineEndpoint({
  id: "threads.files.write",
  summary: "Create, move, copy, or delete a file in the Thread's Orb",
  method: "POST",
  path: "/v1/threads/:threadId/files",
  params: ThreadFilesParamsSchema,
  query: WriteThreadFilesQuerySchema,
  body: WriteThreadFilesRequestSchema,
  success: WriteThreadFilesResponseSchema,
  refusals: ThreadFilesRefusals,
});

/** The file to read, save, or upload, and its worktree. */
export const ThreadFileParamsSchema = Schema.Struct({
  threadId: ThreadId,
  path: ThreadFilesPath,
});
export const ThreadFileQuerySchema = Schema.Struct({
  worktree: Schema.optional(ThreadFilesWorktreeId),
});

export const GetThreadFileEndpoint = defineEndpoint({
  id: "threads.files.read",
  summary: "Read a file from the Thread's Orb",
  method: "GET",
  path: "/v1/threads/:threadId/files/:path{.+}",
  params: ThreadFileParamsSchema,
  query: ThreadFileQuerySchema,
  success: GetThreadFileResponseSchema,
  refusals: ThreadFilesRefusals,
});

/** Saves a text file the person edited, if it is still `expectedVersion`. */
export const SaveThreadFileEndpoint = defineEndpoint({
  id: "threads.files.save",
  summary: "Save a file in the Thread's Orb",
  method: "PATCH",
  path: "/v1/threads/:threadId/files/:path{.+}",
  params: ThreadFileParamsSchema,
  query: ThreadFileQuerySchema,
  body: SaveThreadFileRequestSchema,
  success: SaveThreadFileResponseSchema,
  refusals: ThreadFilesRefusals,
});

/** A new file with the body's bytes; never replaces an existing one. */
export const UploadThreadFileEndpoint = defineEndpoint({
  id: "threads.files.upload",
  summary: "Upload a file into the Thread's Orb",
  method: "PUT",
  path: "/v1/threads/:threadId/files/:path{.+}",
  params: ThreadFileParamsSchema,
  query: ThreadFileQuerySchema,
  upload: "bytes",
  success: WriteThreadFilesResponseSchema,
  successStatus: 201,
  refusals: ThreadFilesRefusals,
});
