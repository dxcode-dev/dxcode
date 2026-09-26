import { Effect, Schema } from "effect";
import { PageCursor } from "../pagination/cursor.js";
import { ProjectId } from "../projects/project-id.js";
import { ModelProviderId } from "../settings/model-routing.js";
import { ThreadId } from "../threads/thread-id.js";

export const MAX_USAGE_RANGE_DAYS = 93;
export const DEFAULT_USAGE_PAGE_LIMIT = 20;
export const USAGE_EVENT_RETENTION_DAYS = 180;

const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const UsageDate = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/),
).pipe(Schema.brand("@dx/UsageDate"));

export type UsageDate = typeof UsageDate.Type;

export const UsageEventId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(512),
).pipe(Schema.brand("@dx/UsageEventId"));

export type UsageEventId = typeof UsageEventId.Type;

export const UsageEventKind = Schema.Literals([
  "model",
  "submission",
  "tool",
  "runner",
]);

export type UsageEventKind = typeof UsageEventKind.Type;

/**
 * Provider-scoped model id (e.g. `gpt-5.2`, `@cf/zai-org/glm-5.3-flash`) as
 * recorded by usage telemetry and price rows — NOT the canonical
 * `provider/model` `ModelId` used by model routing.
 */
export const UsageModelId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
).pipe(Schema.brand("@dx/UsageModelId"));

export type UsageModelId = typeof UsageModelId.Type;

export const UsageOutcome = Schema.Literals([
  "success",
  "error",
  "cancelled",
  "unknown",
]);

export type UsageOutcome = typeof UsageOutcome.Type;

export const UsageRunnerDecision = Schema.Literals(["create", "connect"]);

export type UsageRunnerDecision = typeof UsageRunnerDecision.Type;

export const UsageRunnerResourceAttribution = Schema.Struct({
  profileId: Schema.NullOr(Schema.String),
  profileVersion: Schema.NullOr(NonNegativeInteger),
  cpuCores: Schema.NullOr(Schema.Number.check(Schema.isGreaterThan(0))),
  memoryMb: Schema.NullOr(NonNegativeInteger),
  diskGb: Schema.NullOr(NonNegativeInteger),
});

export type UsageRunnerResourceAttribution =
  typeof UsageRunnerResourceAttribution.Type;

export const UsageRouteAttribution = Schema.Struct({
  connectionId: Schema.String,
  providerId: Schema.String,
  modelId: Schema.String,
});

export type UsageRouteAttribution = typeof UsageRouteAttribution.Type;

const UsageEventBase = {
  id: UsageEventId,
  threadId: ThreadId,
  occurredAt: Schema.DateTimeUtcFromString,
  outcome: UsageOutcome,
  durationMs: Schema.NullOr(NonNegativeInteger),
} as const;

export const ModelUsageEventInput = Schema.Struct({
  ...UsageEventBase,
  kind: Schema.Literal("model"),
  submissionId: Schema.NullOr(Schema.String),
  turnId: Schema.String,
  purpose: Schema.Literals(["agent", "compaction", "compaction_prefix"]),
  observedProviderId: Schema.String,
  observedProviderName: Schema.String,
  observedModelId: Schema.String,
  routeAttribution: Schema.optional(UsageRouteAttribution),
  inputTokens: Schema.NullOr(NonNegativeInteger),
  outputTokens: Schema.NullOr(NonNegativeInteger),
  cacheReadTokens: Schema.NullOr(NonNegativeInteger),
  cacheWriteTokens: Schema.NullOr(NonNegativeInteger),
  reasoningTokens: Schema.NullOr(NonNegativeInteger),
  totalTokens: Schema.NullOr(NonNegativeInteger),
});

export type ModelUsageEventInput = typeof ModelUsageEventInput.Type;

export const SubmissionUsageEventInput = Schema.Struct({
  ...UsageEventBase,
  kind: Schema.Literal("submission"),
  submissionId: Schema.String,
});

export type SubmissionUsageEventInput = typeof SubmissionUsageEventInput.Type;

export const ToolUsageEventInput = Schema.Struct({
  ...UsageEventBase,
  kind: Schema.Literal("tool"),
  submissionId: Schema.NullOr(Schema.String),
  toolCallId: Schema.String,
  toolName: Schema.String,
  toolOrigin: Schema.NullOr(
    Schema.Literals(["model", "caller", "framework", "adapter"]),
  ),
  runtime: Schema.Literal("flue"),
});

export type ToolUsageEventInput = typeof ToolUsageEventInput.Type;

export const RunnerUsageEventInput = Schema.Struct({
  ...UsageEventBase,
  kind: Schema.Literal("runner"),
  provider: Schema.Literal("e2b"),
  decision: UsageRunnerDecision,
  runnerId: Schema.NullOr(Schema.String),
  template: Schema.String,
  activeTimeoutMs: NonNegativeInteger,
  resources: UsageRunnerResourceAttribution,
});

export type RunnerUsageEventInput = typeof RunnerUsageEventInput.Type;

export const UsageEventInput = Schema.Union([
  ModelUsageEventInput,
  SubmissionUsageEventInput,
  ToolUsageEventInput,
  RunnerUsageEventInput,
]);

export type UsageEventInput = typeof UsageEventInput.Type;

export const UsagePriceSource = Schema.Literals(["deployment", "catalog"]);

export type UsagePriceSource = typeof UsagePriceSource.Type;

export const UsageCurrency = Schema.Literal("USD");

export type UsageCurrency = typeof UsageCurrency.Type;

export const UsagePriceMetadata = Schema.Struct({
  providerId: ModelProviderId,
  modelId: UsageModelId,
  currency: UsageCurrency,
  source: UsagePriceSource,
  sourceVersion: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(128),
  ),
  inputMicrosPerMillion: NonNegativeInteger,
  outputMicrosPerMillion: NonNegativeInteger,
  cacheReadMicrosPerMillion: NonNegativeInteger,
  cacheWriteMicrosPerMillion: NonNegativeInteger,
  effectiveFrom: Schema.DateTimeUtcFromString,
  effectiveTo: Schema.NullOr(Schema.DateTimeUtcFromString),
  freshUntil: Schema.DateTimeUtcFromString,
  estimated: Schema.Literal(true),
});

export type UsagePriceMetadata = typeof UsagePriceMetadata.Type;

export const UsageQuery = Schema.Struct({
  from: UsageDate,
  to: UsageDate,
  timezoneOffsetMinutes: Schema.Int.check(
    Schema.isBetween({ minimum: -840, maximum: 840 }),
  ),
  projectId: Schema.optional(ProjectId),
  threadId: Schema.optional(ThreadId),
  providerId: Schema.optional(ModelProviderId),
  modelId: Schema.optional(UsageModelId),
  cursor: Schema.optional(PageCursor),
  limit: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
  ),
});

export type UsageQuery = typeof UsageQuery.Type;

export interface NormalizedUsageQuery extends UsageQuery {
  readonly fromInclusive: string;
  readonly toExclusive: string;
  readonly timezone: string;
  readonly sqliteTimezoneModifier: string;
  readonly limit: number;
}

export class InvalidUsageQuery extends Schema.TaggedError<InvalidUsageQuery>()(
  "InvalidUsageQuery",
  { reason: Schema.Literals(["date", "order", "range", "cursor"]) },
) {}

export class UsageResourceForbidden extends Schema.TaggedError<UsageResourceForbidden>()(
  "UsageResourceForbidden",
  {},
) {}

const parseDate = (value: UsageDate): number | undefined => {
  const [year, month, day] = value.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    return undefined;
  }
  const epoch = Date.UTC(year, month - 1, day);
  const date = new Date(epoch);
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? epoch
    : undefined;
};

export const usageTimezoneLabel = (offsetMinutes: number): string => {
  if (offsetMinutes === 0) return "UTC";
  const sign = offsetMinutes > 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  return `UTC${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
};

export const normalizeUsageQuery = Effect.fn("normalizeUsageQuery")(function* (
  query: UsageQuery,
) {
  const fromLocal = parseDate(query.from);
  const toLocal = parseDate(query.to);
  if (fromLocal === undefined || toLocal === undefined) {
    return yield* new InvalidUsageQuery({ reason: "date" });
  }
  if (toLocal < fromLocal) {
    return yield* new InvalidUsageQuery({ reason: "order" });
  }
  const days = Math.floor((toLocal - fromLocal) / 86_400_000) + 1;
  if (days > MAX_USAGE_RANGE_DAYS) {
    return yield* new InvalidUsageQuery({ reason: "range" });
  }
  const offsetMs = query.timezoneOffsetMinutes * 60_000;
  return {
    ...query,
    fromInclusive: new Date(fromLocal - offsetMs).toISOString(),
    toExclusive: new Date(toLocal + 86_400_000 - offsetMs).toISOString(),
    timezone: usageTimezoneLabel(query.timezoneOffsetMinutes),
    sqliteTimezoneModifier: `${query.timezoneOffsetMinutes >= 0 ? "+" : ""}${query.timezoneOffsetMinutes} minutes`,
    limit: query.limit ?? DEFAULT_USAGE_PAGE_LIMIT,
  } satisfies NormalizedUsageQuery;
});

export interface UsageTokenCounts {
  readonly input: number | null;
  readonly output: number | null;
  readonly cacheRead: number | null;
  readonly cacheWrite: number | null;
}

export interface UsagePriceRates {
  readonly inputMicrosPerMillion: number;
  readonly outputMicrosPerMillion: number;
  readonly cacheReadMicrosPerMillion: number;
  readonly cacheWriteMicrosPerMillion: number;
}

export const estimateUsageCostMicros = (
  tokens: UsageTokenCounts,
  price: UsagePriceRates | undefined,
): number | null => {
  if (
    price === undefined ||
    tokens.input === null ||
    tokens.output === null ||
    tokens.cacheRead === null ||
    tokens.cacheWrite === null
  ) {
    return null;
  }
  const millionths =
    tokens.input * price.inputMicrosPerMillion +
    tokens.output * price.outputMicrosPerMillion +
    tokens.cacheRead * price.cacheReadMicrosPerMillion +
    tokens.cacheWrite * price.cacheWriteMicrosPerMillion;
  return Math.round(millionths / 1_000_000);
};

const UsageThreadCursorPayload = Schema.Struct({
  v: Schema.Literal(1),
  estimatedCostMicros: Schema.Int,
  threadId: ThreadId,
});

const UsageThreadCursorCodec = Schema.StringFromBase64Url.pipe(
  Schema.decodeTo(Schema.fromJsonString(UsageThreadCursorPayload)),
);

export interface UsageThreadCursorPosition {
  readonly estimatedCostMicros: number;
  readonly threadId: ThreadId;
}

export const encodeUsageThreadCursor = (
  position: UsageThreadCursorPosition,
): Effect.Effect<PageCursor, Schema.SchemaError> =>
  Schema.encodeEffect(UsageThreadCursorCodec)({ v: 1, ...position }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(PageCursor)),
  );

export const decodeUsageThreadCursor = (
  cursor: PageCursor,
): Effect.Effect<UsageThreadCursorPosition, InvalidUsageQuery> =>
  Schema.decodeUnknownEffect(UsageThreadCursorCodec)(cursor).pipe(
    Effect.map(({ estimatedCostMicros, threadId }) => ({
      estimatedCostMicros,
      threadId,
    })),
    Effect.mapError(() => new InvalidUsageQuery({ reason: "cursor" })),
  );
