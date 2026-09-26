import {
  ModelProviderId,
  PageCursor,
  ProjectId,
  ThreadId,
  UsageCurrency,
  UsageDate,
  UsageModelId,
  UsagePriceSource,
} from "@dx/domain";
import { Schema } from "effect";
import { PageLimitQuerySchema } from "../http/page-limit-query.js";
import { errorResponse, successResponse } from "../http/response.js";

export const TimezoneOffsetQuerySchema = Schema.String.check(
  Schema.isPattern(/^-?[0-9]{1,4}$/),
).pipe(
  Schema.decodeTo(Schema.FiniteFromString),
  Schema.decodeTo(
    Schema.Int.check(Schema.isBetween({ minimum: -840, maximum: 840 })),
  ),
);

export const PersonalUsageQuerySchema = Schema.Struct({
  from: UsageDate,
  to: UsageDate,
  timezoneOffsetMinutes: TimezoneOffsetQuerySchema,
  projectId: Schema.optional(ProjectId),
  threadId: Schema.optional(ThreadId),
  providerId: Schema.optional(ModelProviderId),
  modelId: Schema.optional(UsageModelId),
  cursor: Schema.optional(PageCursor),
  limit: Schema.optional(PageLimitQuerySchema),
});

export const UsageTokensDataSchema = Schema.Struct({
  input: Schema.Int,
  output: Schema.Int,
  cacheRead: Schema.Int,
  cacheWrite: Schema.Int,
  reasoning: Schema.NullOr(Schema.Int),
  total: Schema.Int,
  unknownEvents: Schema.Int,
});

export const UsageEstimatedCostDataSchema = Schema.Struct({
  amountMicros: Schema.Int,
  currency: UsageCurrency,
  estimated: Schema.Literal(true),
  knownEvents: Schema.Int,
  unknownEvents: Schema.Int,
});

export const UsageSummaryDataSchema = Schema.Struct({
  tokens: UsageTokensDataSchema,
  estimatedCost: UsageEstimatedCostDataSchema,
  modelTurns: Schema.Int,
  averageLatencyMs: Schema.NullOr(Schema.Number),
  toolDurationMs: Schema.Int,
  runnerDurationMs: Schema.Int,
  outcomes: Schema.Struct({
    success: Schema.Int,
    error: Schema.Int,
    cancelled: Schema.Int,
    unknown: Schema.Int,
  }),
});

export const UsageDailyTrendDataSchema = Schema.Struct({
  day: UsageDate,
  totalTokens: Schema.Int,
  unknownTokenEvents: Schema.Int,
  estimatedCostMicros: Schema.Int,
  unknownCostEvents: Schema.Int,
  averageLatencyMs: Schema.NullOr(Schema.Number),
  runnerDurationMs: Schema.Int,
  modelTurns: Schema.Int,
});

export type UsageDailyTrendData = typeof UsageDailyTrendDataSchema.Type;

export const UsageThreadDataSchema = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  projectName: Schema.String,
  createdAt: Schema.DateTimeUtcFromString,
  providerId: ModelProviderId,
  modelId: UsageModelId,
  profileId: Schema.String,
  profileVersion: Schema.Int,
  totalTokens: Schema.Int,
  unknownTokenEvents: Schema.Int,
  estimatedCostMicros: Schema.Int,
  unknownCostEvents: Schema.Int,
  averageLatencyMs: Schema.NullOr(Schema.Number),
  runnerDurationMs: Schema.Int,
  modelTurns: Schema.Int,
  errorEvents: Schema.Int,
});

export type UsageThreadData = typeof UsageThreadDataSchema.Type;

export const UsageRunnerDataSchema = Schema.Struct({
  provider: Schema.Literal("e2b"),
  profileId: Schema.NullOr(Schema.String),
  profileVersion: Schema.NullOr(Schema.Int),
  template: Schema.String,
  cpuCores: Schema.NullOr(Schema.Number),
  memoryMb: Schema.NullOr(Schema.Int),
  diskGb: Schema.NullOr(Schema.Int),
  durationMs: Schema.Int,
  events: Schema.Int,
  unknownResourceEvents: Schema.Int,
});

export type UsageRunnerData = typeof UsageRunnerDataSchema.Type;

export const UsagePriceSourceDataSchema = Schema.Struct({
  source: UsagePriceSource,
  sourceVersion: Schema.String,
  currency: UsageCurrency,
  effectiveFrom: Schema.DateTimeUtcFromString,
  effectiveTo: Schema.NullOr(Schema.DateTimeUtcFromString),
  freshUntil: Schema.DateTimeUtcFromString,
  estimated: Schema.Literal(true),
});

export const PersonalUsageDataSchema = Schema.Struct({
  range: Schema.Struct({
    from: UsageDate,
    to: UsageDate,
    timezoneOffsetMinutes: Schema.Int,
    timezone: Schema.String,
  }),
  filters: Schema.Struct({
    projectId: Schema.optional(ProjectId),
    threadId: Schema.optional(ThreadId),
    providerId: Schema.optional(ModelProviderId),
    modelId: Schema.optional(UsageModelId),
  }),
  summary: UsageSummaryDataSchema,
  daily: Schema.Array(UsageDailyTrendDataSchema),
  threads: Schema.Array(UsageThreadDataSchema),
  runners: Schema.Array(UsageRunnerDataSchema),
  priceSources: Schema.Array(UsagePriceSourceDataSchema),
  nextCursor: Schema.optional(PageCursor),
});

export type PersonalUsageData = typeof PersonalUsageDataSchema.Type;

export const GetPersonalUsageResponseSchema = successResponse(
  PersonalUsageDataSchema,
);

export const PersonalUsageExportDataSchema = Schema.Struct({
  filename: Schema.String,
  contentType: Schema.Literal("text/csv;charset=utf-8"),
  content: Schema.String,
  rows: Schema.Int,
  timezone: Schema.String,
  estimated: Schema.Literal(true),
});

export type PersonalUsageExportData = typeof PersonalUsageExportDataSchema.Type;

export const ExportPersonalUsageResponseSchema = successResponse(
  PersonalUsageExportDataSchema,
);

export const PersonalUsageInvalidRequestResponseSchema = errorResponse(
  "INVALID_USAGE_QUERY",
  "Usage query validation failed.",
);

export const PersonalUsageForbiddenResponseSchema = errorResponse(
  "USAGE_RESOURCE_FORBIDDEN",
  "The requested usage resource is unavailable for this user.",
);

export const PersonalUsageUnavailableResponseSchema = errorResponse(
  "PERSISTENCE_UNAVAILABLE",
  "Usage is temporarily unavailable.",
);

export const PersonalUsageErrorResponseSchema = Schema.Union([
  PersonalUsageInvalidRequestResponseSchema,
  PersonalUsageForbiddenResponseSchema,
  PersonalUsageUnavailableResponseSchema,
]);
