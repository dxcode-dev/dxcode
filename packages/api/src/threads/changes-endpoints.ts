import { Schema } from "effect";
import { defineEndpoint } from "../http/endpoint.js";
import {
  GetThreadChangesDiffResponseSchema,
  GetThreadChangesResponseSchema,
  GetThreadShipPlanResponseSchema,
  PushThreadChangesRequestSchema,
  PushThreadChangesResponseSchema,
  ThreadChangesCaptureId,
  ThreadChangesConflictResponseSchema,
  ThreadChangesInvalidRequestResponseSchema,
  ThreadChangesParamsSchema,
  ThreadChangesPath,
  ThreadChangesUnavailableResponseSchema,
  ThreadChangesWorktreeId,
} from "./changes.js";
import { ThreadAccessRefusals } from "./thread-access-refusals.js";

/** The Changes endpoints, apart from `changes.ts`'s schemas. */

/** A range in a URL: `all`, `uncommitted`, or `commit:<sha>`. */
export const ThreadChangesRangeQueryValue = Schema.String.check(
  Schema.isPattern(/^(?:all|uncommitted|commit:[a-f0-9]{40})$/),
);

export const GetThreadChangesQuerySchema = Schema.Struct({
  range: ThreadChangesRangeQueryValue,
});

export const GetThreadChangesDiffQuerySchema = Schema.Struct({
  path: ThreadChangesPath,
  range: ThreadChangesRangeQueryValue,
  captureId: ThreadChangesCaptureId,
  worktree: ThreadChangesWorktreeId,
});

export const GetThreadChangesEndpoint = defineEndpoint({
  id: "threads.changes.get",
  summary: "List the Thread's changed files",
  method: "GET",
  path: "/v1/threads/:threadId/changes",
  params: ThreadChangesParamsSchema,
  query: GetThreadChangesQuerySchema,
  success: GetThreadChangesResponseSchema,
  refusals: [
    ...ThreadAccessRefusals,
    { status: 400, schema: ThreadChangesInvalidRequestResponseSchema },
    { status: 503, schema: ThreadChangesUnavailableResponseSchema },
  ],
});

export const GetThreadChangesDiffEndpoint = defineEndpoint({
  id: "threads.changes.diff",
  summary: "Read one changed file's diff",
  method: "GET",
  path: "/v1/threads/:threadId/changes/diff",
  params: ThreadChangesParamsSchema,
  query: GetThreadChangesDiffQuerySchema,
  success: GetThreadChangesDiffResponseSchema,
  refusals: [
    ...ThreadAccessRefusals,
    { status: 400, schema: ThreadChangesInvalidRequestResponseSchema },
    { status: 503, schema: ThreadChangesUnavailableResponseSchema },
  ],
});

export const GetThreadShipPlanEndpoint = defineEndpoint({
  id: "threads.changes.shipPlan",
  summary: "Read how the Thread's changes would ship",
  method: "GET",
  path: "/v1/threads/:threadId/changes/ship",
  params: ThreadChangesParamsSchema,
  success: GetThreadShipPlanResponseSchema,
  refusals: [
    ...ThreadAccessRefusals,
    { status: 503, schema: ThreadChangesUnavailableResponseSchema },
  ],
});

export const PushThreadChangesEndpoint = defineEndpoint({
  id: "threads.changes.push",
  summary: "Push the Thread's captured changes",
  method: "POST",
  path: "/v1/threads/:threadId/changes/push",
  params: ThreadChangesParamsSchema,
  body: PushThreadChangesRequestSchema,
  success: PushThreadChangesResponseSchema,
  refusals: [
    ...ThreadAccessRefusals,
    { status: 400, schema: ThreadChangesInvalidRequestResponseSchema },
    { status: 409, schema: ThreadChangesConflictResponseSchema },
    { status: 503, schema: ThreadChangesUnavailableResponseSchema },
  ],
});
