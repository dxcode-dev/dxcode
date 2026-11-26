import { ThreadId } from "@dx/domain";
import { Schema } from "effect";
import { defineEndpoint } from "../http/endpoint.js";
import { ThreadAccessRefusals } from "./thread-access-refusals.js";
import {
  GetThreadClaudePlanResponseSchema,
  GetThreadOrbMetricsResponseSchema,
  GetThreadOrbSessionsResponseSchema,
  GetThreadUsageRequestsResponseSchema,
  GetThreadUsageResponseSchema,
  ThreadClaudePlanOwnerOnlyResponseSchema,
  ThreadUsageInvalidQueryResponseSchema,
  ThreadUsageRequestsQuerySchema,
  ThreadUsageUnavailableResponseSchema,
} from "./thread-usage.js";

/**
 * A Thread's Cost & Usage endpoints. Apart from `thread-usage.ts`'s schemas,
 * so code that imports only the schemas does not carry the endpoints.
 */

export const ThreadUsageParamsSchema = Schema.Struct({ threadId: ThreadId });

export const ThreadOrbSessionsQuerySchema = Schema.Struct({
  cursor: Schema.optional(Schema.String),
});

const threadUsageRefusals = [
  ...ThreadAccessRefusals,
  { status: 503, schema: ThreadUsageUnavailableResponseSchema },
] as const;

export const GetThreadUsageEndpoint = defineEndpoint({
  id: "threads.usage.get",
  summary: "Read a Thread's cost and usage",
  method: "GET",
  path: "/v1/threads/:threadId/usage",
  params: ThreadUsageParamsSchema,
  success: GetThreadUsageResponseSchema,
  refusals: threadUsageRefusals,
});

export const GetThreadUsageRequestsEndpoint = defineEndpoint({
  id: "threads.usage.requests",
  summary: "List a Thread's model requests",
  method: "GET",
  path: "/v1/threads/:threadId/usage/requests",
  params: ThreadUsageParamsSchema,
  query: ThreadUsageRequestsQuerySchema,
  success: GetThreadUsageRequestsResponseSchema,
  refusals: [
    ...threadUsageRefusals,
    { status: 400, schema: ThreadUsageInvalidQueryResponseSchema },
  ],
});

export const GetThreadOrbSessionsEndpoint = defineEndpoint({
  id: "threads.usage.orbSessions",
  summary: "List a Thread's Orb sessions",
  method: "GET",
  path: "/v1/threads/:threadId/usage/orb-sessions",
  params: ThreadUsageParamsSchema,
  query: ThreadOrbSessionsQuerySchema,
  success: GetThreadOrbSessionsResponseSchema,
  refusals: threadUsageRefusals,
});

export const GetThreadOrbMetricsEndpoint = defineEndpoint({
  id: "threads.usage.orbMetrics",
  summary: "Read a Thread's Orb metrics",
  method: "GET",
  path: "/v1/threads/:threadId/usage/orb-metrics",
  params: ThreadUsageParamsSchema,
  success: GetThreadOrbMetricsResponseSchema,
  refusals: threadUsageRefusals,
});

export const GetThreadClaudePlanEndpoint = defineEndpoint({
  id: "threads.usage.claudePlan",
  summary: "Read a Thread's Claude plan usage",
  method: "GET",
  path: "/v1/threads/:threadId/usage/claude-plan",
  params: ThreadUsageParamsSchema,
  success: GetThreadClaudePlanResponseSchema,
  refusals: [
    ...threadUsageRefusals,
    { status: 403, schema: ThreadClaudePlanOwnerOnlyResponseSchema },
  ],
});
