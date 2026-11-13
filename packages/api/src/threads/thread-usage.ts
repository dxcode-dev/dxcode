import { Schema } from "effect";
import { successResponse } from "../http/response.js";

/**
 * A Thread's Cost & Usage (the Thread menu's cost row and its dialog). Every
 * amount is in micro-dollars and every count is a whole number. Model costs
 * are estimates at list price (`usage_price`); Orb costs are the credits a
 * metering deployment charged for its Orb time, else the Orb provider's list
 * price.
 */

const Count = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const Micros = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const Name = Schema.String.check(Schema.isMaxLength(256));
const Iso = Schema.String.check(Schema.isMaxLength(40));

/**
 * Who pays for a model route. `deployment` is this dx deployment's own key;
 * the rest are keys and plans the person or workspace brought, which their
 * provider bills. `claude-code` is a Claude Pro/Max plan running Claude
 * Code; `unknown` is a connection removed since.
 */
export const ThreadUsageRouteKindSchema = Schema.Literals([
  "deployment",
  "custom",
  "provider",
  "subscription",
  "claude-code",
  "unknown",
]);
export type ThreadUsageRouteKind = typeof ThreadUsageRouteKindSchema.Type;

/** One Model Routing connection the Thread's model turns went through. */
export const ThreadUsageRouteSchema = Schema.Struct({
  connectionId: Name,
  name: Name,
  kind: ThreadUsageRouteKindSchema,
  /** Whose settings hold the connection; null for a removed one. */
  scope: Schema.NullOr(Schema.Literals(["personal", "workspace"])),
  /** The workspace's or the person's name, for "from <name>'s settings". */
  ownerName: Schema.NullOr(Name),
  requests: Count,
  listPriceMicros: Micros,
});
export type ThreadUsageRoute = typeof ThreadUsageRouteSchema.Type;

/** Model turns by the provider and model that answered them. */
export const ThreadUsageModelSchema = Schema.Struct({
  providerId: Name,
  modelId: Name,
  modelName: Name,
  requests: Count,
  /** Uncached input; cached reads and writes are counted apart. */
  inputTokens: Count,
  cacheReadTokens: Count,
  cacheWriteTokens: Count,
  outputTokens: Count,
  /** What dx paid: turns through a deployment connection. */
  dxCostMicros: Micros,
  listPriceMicros: Micros,
  /** Turns with no list price (an unpriced model, a Claude plan). */
  unpricedRequests: Count,
});
export type ThreadUsageModel = typeof ThreadUsageModelSchema.Type;

/**
 * How the Thread's Orb time is paid. `credits`: the deployment's credits;
 * `deployment`: this deployment's own Orb account; `workspace`/`personal`:
 * the Orb provider bills that account.
 */
export const ThreadOrbBillingSchema = Schema.Literals([
  "credits",
  "deployment",
  "workspace",
  "personal",
]);
export type ThreadOrbBilling = typeof ThreadOrbBillingSchema.Type;

export const ThreadUsageOrbSchema = Schema.Struct({
  sessions: Count,
  runtimeMs: Count,
  costMicros: Micros,
  /** The part of `costMicros` paid with credits. */
  creditsMicros: Micros,
  billing: ThreadOrbBillingSchema,
  providerId: Name,
  runnerProfileId: Name,
  cpuCores: Schema.NullOr(Schema.Number),
  memoryMb: Schema.NullOr(Count),
});
export type ThreadUsageOrb = typeof ThreadUsageOrbSchema.Type;

/** One MCP server's tool definitions in the context. */
export const ThreadContextMcpServerSchema = Schema.Struct({
  server: Name,
  tokens: Count,
});

/**
 * Estimated input dx would send for the Thread's next request, from what
 * its last agent request sent: system prompt, tool definitions, and the
 * messages, including that request's reply.
 */
export const ThreadContextWindowSchema = Schema.Union([
  Schema.Struct({
    available: Schema.Literal(false),
    reason: Schema.Literals(["archived", "not-loaded", "claude-code"]),
  }),
  Schema.Struct({
    available: Schema.Literal(true),
    providerId: Name,
    modelId: Name,
    modelName: Name,
    usedTokens: Count,
    /** The window dx gives the model; null when the catalog lacks it. */
    maxTokens: Schema.NullOr(Count),
    compactions: Count,
    systemPromptTokens: Count,
    builtinToolTokens: Count,
    mcpServers: Schema.Array(ThreadContextMcpServerSchema).check(
      Schema.isMaxLength(64),
    ),
    messageTokens: Count,
    measuredAt: Iso,
  }),
]);
export type ThreadContextWindow = typeof ThreadContextWindowSchema.Type;

export const ThreadUsageDataSchema = Schema.Struct({
  claudeCode: Schema.Boolean,
  /** dx's cost: deployment-paid model turns plus dx-billed Orb time. */
  totalMicros: Micros,
  /** List price of model turns through keys and plans people brought. */
  byokListPriceMicros: Micros,
  /** Credits the Thread used. */
  creditsMicros: Micros,
  /** List price of every priced model turn, whoever paid. */
  listPriceMicros: Micros,
  tokens: Schema.Struct({
    input: Count,
    cacheRead: Count,
    cacheWrite: Count,
    output: Count,
  }),
  requests: Count,
  routes: Schema.Array(ThreadUsageRouteSchema).check(Schema.isMaxLength(64)),
  models: Schema.Array(ThreadUsageModelSchema).check(Schema.isMaxLength(64)),
  orb: Schema.NullOr(ThreadUsageOrbSchema),
  context: ThreadContextWindowSchema,
});
export type ThreadUsageData = typeof ThreadUsageDataSchema.Type;

export const GetThreadUsageResponseSchema = successResponse(
  ThreadUsageDataSchema,
);
export type GetThreadUsageResponse = typeof GetThreadUsageResponseSchema.Type;

export const THREAD_USAGE_REQUEST_PAGE = 50;

export const ThreadUsageRequestsQuerySchema = Schema.Struct({
  providerId: Name,
  modelId: Name,
  /** The last row of the previous page, `<occurredAt>|<id>`. */
  cursor: Schema.optional(Schema.String.check(Schema.isMaxLength(600))),
});

/** One model request, newest first. */
export const ThreadUsageRequestSchema = Schema.Struct({
  id: Schema.String.check(Schema.isMaxLength(512)),
  occurredAt: Iso,
  purpose: Schema.Literals(["agent", "compaction", "compaction_prefix"]),
  outcome: Schema.Literals(["success", "error", "cancelled", "unknown"]),
  routeName: Name,
  inputTokens: Count,
  cacheReadTokens: Count,
  cacheWriteTokens: Count,
  outputTokens: Count,
  dxCostMicros: Micros,
  /** Null when the turn has no list price. */
  listPriceMicros: Schema.NullOr(Micros),
});
export type ThreadUsageRequest = typeof ThreadUsageRequestSchema.Type;

export const ThreadUsageRequestsDataSchema = Schema.Struct({
  requests: Schema.Array(ThreadUsageRequestSchema).check(
    Schema.isMaxLength(THREAD_USAGE_REQUEST_PAGE),
  ),
  nextCursor: Schema.NullOr(Schema.String),
});
export type ThreadUsageRequestsData = typeof ThreadUsageRequestsDataSchema.Type;

export const GetThreadUsageRequestsResponseSchema = successResponse(
  ThreadUsageRequestsDataSchema,
);

export const THREAD_ORB_SESSION_PAGE = 50;

/** One Orb run, newest first: from the daemon's start to its last beat. */
export const ThreadOrbSessionSchema = Schema.Struct({
  startedAt: Iso,
  endedAt: Iso,
  runtimeMs: Count,
  providerId: Name,
  runnerProfileId: Name,
  cpuCores: Schema.NullOr(Schema.Number),
  memoryMb: Schema.NullOr(Count),
  costMicros: Micros,
  billing: ThreadOrbBillingSchema,
});
export type ThreadOrbSession = typeof ThreadOrbSessionSchema.Type;

export const ThreadOrbSessionsDataSchema = Schema.Struct({
  sessions: Schema.Array(ThreadOrbSessionSchema).check(
    Schema.isMaxLength(THREAD_ORB_SESSION_PAGE),
  ),
  /** The `startedAt` epoch ms to continue before; null on the last page. */
  nextCursor: Schema.NullOr(Schema.String),
});
export type ThreadOrbSessionsData = typeof ThreadOrbSessionsDataSchema.Type;

export const GetThreadOrbSessionsResponseSchema = successResponse(
  ThreadOrbSessionsDataSchema,
);

/** At most this many samples are kept per Thread, newest kept. */
export const THREAD_ORB_METRIC_SAMPLES = 720;

/** One sample of the Orb, in percent of its capacity. */
export const ThreadOrbMetricSampleSchema = Schema.Struct({
  at: Count,
  cpuPercent: Schema.NullOr(Schema.Number),
  memoryPercent: Schema.NullOr(Schema.Number),
  diskPercent: Schema.NullOr(Schema.Number),
});
export type ThreadOrbMetricSample = typeof ThreadOrbMetricSampleSchema.Type;

export const ThreadOrbMetricsDataSchema = Schema.Struct({
  /** The provider's sandbox ID; null before the Orb first started. */
  orbId: Schema.NullOr(Name),
  samples: Schema.Array(ThreadOrbMetricSampleSchema).check(
    Schema.isMaxLength(THREAD_ORB_METRIC_SAMPLES),
  ),
  /** Memory over the kept samples; null without one. */
  memory: Schema.NullOr(
    Schema.Struct({
      p50Bytes: Count,
      p99Bytes: Count,
      peakBytes: Count,
      totalBytes: Count,
      samples: Count,
    }),
  ),
});
export type ThreadOrbMetricsData = typeof ThreadOrbMetricsDataSchema.Type;

export const GetThreadOrbMetricsResponseSchema = successResponse(
  ThreadOrbMetricsDataSchema,
);

/**
 * The Claude Pro/Max plan a Claude Code Thread runs on, for its owner.
 * `bound`: the plan by its connection; `removed`: its plan was deleted, and
 * it takes no other; `none`: it has not run Claude Code yet, and its first
 * Claude Code turn picks one as Auto does.
 */
export const ThreadClaudePlanDataSchema = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("bound"),
    connectionId: Schema.String.check(Schema.isMaxLength(128)),
  }),
  Schema.Struct({ state: Schema.Literals(["removed", "none"]) }),
]);

export type ThreadClaudePlanData = typeof ThreadClaudePlanDataSchema.Type;

export const GetThreadClaudePlanResponseSchema = Schema.Struct({
  status: Schema.Literal("success"),
  data: ThreadClaudePlanDataSchema,
});
