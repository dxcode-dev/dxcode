import { ThreadId } from "@dx/domain";
import { Schema } from "effect";
import { defineEndpoint } from "../http/endpoint.js";
import {
  DeleteThreadOrbFolderRequestSchema,
  DeleteThreadOrbFolderResponseSchema,
  GetThreadOrbDiskResponseSchema,
  ThreadOrbDiskReadOnlyResponseSchema,
  ThreadOrbFolderErrorResponseSchema,
} from "./orb-disk.js";
import {
  ThreadAccessRefusals,
  ThreadActiveRefusals,
} from "./thread-access-refusals.js";

/** The Orb disk endpoints, apart from `orb-disk.ts`'s schemas. */

export const ThreadOrbDiskParamsSchema = Schema.Struct({ threadId: ThreadId });

/** `?folders=1` also measures the largest folders. */
export const ThreadOrbDiskQuerySchema = Schema.Struct({
  folders: Schema.optional(Schema.Literal("1")),
});

const orbDiskRefusals = [
  ...ThreadAccessRefusals,
  { status: 403, schema: ThreadOrbDiskReadOnlyResponseSchema },
  ...ThreadActiveRefusals,
] as const;

export const GetThreadOrbDiskEndpoint = defineEndpoint({
  id: "threads.orbDisk.get",
  summary: "Read a Thread's Orb disk usage",
  method: "GET",
  path: "/v1/threads/:threadId/disk",
  params: ThreadOrbDiskParamsSchema,
  query: ThreadOrbDiskQuerySchema,
  success: GetThreadOrbDiskResponseSchema,
  refusals: orbDiskRefusals,
});

export const DeleteThreadOrbFolderEndpoint = defineEndpoint({
  id: "threads.orbDisk.deleteFolder",
  summary: "Delete folders from a Thread's Orb disk",
  method: "POST",
  path: "/v1/threads/:threadId/disk/folders/delete",
  params: ThreadOrbDiskParamsSchema,
  body: DeleteThreadOrbFolderRequestSchema,
  success: DeleteThreadOrbFolderResponseSchema,
  // One union of codes, each sent with its own status.
  refusals: [
    ...orbDiskRefusals,
    { status: 400, schema: ThreadOrbFolderErrorResponseSchema },
    { status: 403, schema: ThreadOrbFolderErrorResponseSchema },
    { status: 404, schema: ThreadOrbFolderErrorResponseSchema },
    { status: 409, schema: ThreadOrbFolderErrorResponseSchema },
    { status: 503, schema: ThreadOrbFolderErrorResponseSchema },
  ],
});
