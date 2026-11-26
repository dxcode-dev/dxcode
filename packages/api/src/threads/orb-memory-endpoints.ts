import { ThreadId } from "@dx/domain";
import { Schema } from "effect";
import { defineEndpoint } from "../http/endpoint.js";
import {
  GetThreadOrbMemoryResponseSchema,
  OrbProcessIdSchema,
  StopThreadOrbProcessResponseSchema,
  ThreadOrbMemoryReadOnlyResponseSchema,
  ThreadOrbProcessErrorResponseSchema,
} from "./orb-memory.js";
import {
  ThreadAccessRefusals,
  ThreadActiveRefusals,
} from "./thread-access-refusals.js";

/** The Orb memory endpoints, apart from `orb-memory.ts`'s schemas. */

export const ThreadOrbMemoryParamsSchema = Schema.Struct({
  threadId: ThreadId,
});
export const StopThreadOrbProcessParamsSchema = Schema.Struct({
  threadId: ThreadId,
  processId: OrbProcessIdSchema,
});

const orbMemoryRefusals = [
  ...ThreadAccessRefusals,
  { status: 403, schema: ThreadOrbMemoryReadOnlyResponseSchema },
  ...ThreadActiveRefusals,
] as const;

export const GetThreadOrbMemoryEndpoint = defineEndpoint({
  id: "threads.orbMemory.get",
  summary: "Read a Thread's Orb memory and processes",
  method: "GET",
  path: "/v1/threads/:threadId/memory",
  params: ThreadOrbMemoryParamsSchema,
  success: GetThreadOrbMemoryResponseSchema,
  refusals: orbMemoryRefusals,
});

export const StopThreadOrbProcessEndpoint = defineEndpoint({
  id: "threads.orbMemory.stopProcess",
  summary: "Stop a process in a Thread's Orb",
  method: "POST",
  path: "/v1/threads/:threadId/memory/processes/:processId/stop",
  params: StopThreadOrbProcessParamsSchema,
  success: StopThreadOrbProcessResponseSchema,
  // One union of codes, each sent with its own status.
  refusals: [
    ...orbMemoryRefusals,
    { status: 400, schema: ThreadOrbProcessErrorResponseSchema },
    { status: 403, schema: ThreadOrbProcessErrorResponseSchema },
    { status: 404, schema: ThreadOrbProcessErrorResponseSchema },
    { status: 409, schema: ThreadOrbProcessErrorResponseSchema },
    { status: 503, schema: ThreadOrbProcessErrorResponseSchema },
  ],
});
