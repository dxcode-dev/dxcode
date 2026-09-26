import {
  MAX_PRIVATE_THREAD_INSPECTION_REASON_LENGTH,
  PageCursor,
  ProjectId,
  ThreadId,
  UsageDate,
  UserId,
  WorkspacePrivateThreadInspectionReason,
  WorkspaceShortName,
  WorkspaceThreadLifecycle,
  WorkspaceThreadVisibility,
  WorkspaceUsageAuditId,
  WorkspaceUsageAuditResult,
  WorkspaceUsageRanking,
} from "@dx/domain";
import { Schema } from "effect";
import { PageLimitQuerySchema } from "../http/page-limit-query.js";
import { errorResponse, successResponse } from "../http/response.js";
import {
  PersonalUsageExportDataSchema,
  TimezoneOffsetQuerySchema,
  UsageDailyTrendDataSchema,
  UsagePriceSourceDataSchema,
  UsageRunnerDataSchema,
  UsageSummaryDataSchema,
} from "./personal-usage.js";

export const WORKSPACE_CONTENT_SUMMARY_UNAVAILABLE_REASON =
  "No authorization-aware content summary is stored by dx or exposed by Flue. Prompts and responses were not read.";

export const WorkspaceUsageParamsSchema = Schema.Struct({
  workspaceSlug: WorkspaceShortName,
});

export const WorkspaceUsageQuerySchema = Schema.Struct({
  from: UsageDate,
  to: UsageDate,
  timezoneOffsetMinutes: TimezoneOffsetQuerySchema,
  userId: Schema.optional(UserId),
  projectId: Schema.optional(ProjectId),
  providerId: Schema.optional(Schema.String),
  modelId: Schema.optional(Schema.String),
  ranking: Schema.optional(WorkspaceUsageRanking),
  cursor: Schema.optional(PageCursor),
  limit: Schema.optional(PageLimitQuerySchema),
});

const WorkspaceUsageAggregateFields = {
  totalTokens: Schema.Int,
  unknownTokenEvents: Schema.Int,
  estimatedCostMicros: Schema.Int,
  unknownCostEvents: Schema.Int,
  averageLatencyMs: Schema.NullOr(Schema.Number),
  runnerDurationMs: Schema.Int,
  modelTurns: Schema.Int,
  errorEvents: Schema.Int,
} as const;

export const WorkspaceUsageUserDataSchema = Schema.Struct({
  userId: UserId,
  userName: Schema.String,
  ...WorkspaceUsageAggregateFields,
});

export const WorkspaceUsageProjectDataSchema = Schema.Struct({
  projectId: ProjectId,
  projectName: Schema.String,
  ownerUserId: UserId,
  ownerName: Schema.String,
  ...WorkspaceUsageAggregateFields,
});

export const WorkspaceUsageRankingDataSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("users"),
    items: Schema.Array(WorkspaceUsageUserDataSchema),
    nextCursor: Schema.optional(PageCursor),
  }),
  Schema.Struct({
    kind: Schema.Literal("projects"),
    items: Schema.Array(WorkspaceUsageProjectDataSchema),
    nextCursor: Schema.optional(PageCursor),
  }),
]);

export const WorkspacePrivateInspectionCapabilityDataSchema = Schema.Struct({
  permitted: Schema.Boolean,
  requiredRole: Schema.Literal("auditor"),
  contentSummary: Schema.Struct({
    available: Schema.Literal(false),
    reason: Schema.Literal(WORKSPACE_CONTENT_SUMMARY_UNAVAILABLE_REASON),
  }),
});

export const WorkspaceUsageDataSchema = Schema.Struct({
  range: Schema.Struct({
    from: UsageDate,
    to: UsageDate,
    timezoneOffsetMinutes: Schema.Int,
    timezone: Schema.String,
  }),
  filters: Schema.Struct({
    userId: Schema.optional(UserId),
    projectId: Schema.optional(ProjectId),
    providerId: Schema.optional(Schema.String),
    modelId: Schema.optional(Schema.String),
  }),
  summary: UsageSummaryDataSchema,
  daily: Schema.Array(UsageDailyTrendDataSchema),
  ranking: WorkspaceUsageRankingDataSchema,
  runners: Schema.Array(UsageRunnerDataSchema),
  priceSources: Schema.Array(UsagePriceSourceDataSchema),
  privateInspection: WorkspacePrivateInspectionCapabilityDataSchema,
});

export const GetWorkspaceUsageResponseSchema = successResponse(
  WorkspaceUsageDataSchema,
);

export const ExportWorkspaceUsageResponseSchema = successResponse(
  PersonalUsageExportDataSchema,
);

export const InspectWorkspacePrivateThreadRequestSchema = Schema.Struct({
  threadId: ThreadId,
  reason: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_PRIVATE_THREAD_INSPECTION_REASON_LENGTH),
  ),
});

export const WorkspacePrivateThreadInspectionDataSchema = Schema.Struct({
  auditId: WorkspaceUsageAuditId,
  auditedAt: Schema.DateTimeUtcFromString,
  thread: Schema.Struct({
    threadId: ThreadId,
    projectId: ProjectId,
    projectName: Schema.String,
    visibility: WorkspaceThreadVisibility,
    lifecycle: WorkspaceThreadLifecycle,
    createdAt: Schema.DateTimeUtcFromString,
    updatedAt: Schema.DateTimeUtcFromString,
    usage: Schema.Struct({
      totalTokens: Schema.Int,
      unknownTokenEvents: Schema.Int,
      modelTurns: Schema.Int,
      averageLatencyMs: Schema.NullOr(Schema.Number),
      runnerDurationMs: Schema.Int,
      firstObservedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
      lastObservedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
    }),
  }),
  contentSummary: Schema.Struct({
    status: Schema.Literal("unavailable"),
    reason: Schema.Literal(WORKSPACE_CONTENT_SUMMARY_UNAVAILABLE_REASON),
  }),
});

export const InspectWorkspacePrivateThreadResponseSchema = successResponse(
  WorkspacePrivateThreadInspectionDataSchema,
);

export const WorkspaceUsageAuditQuerySchema = Schema.Struct({
  from: UsageDate,
  to: UsageDate,
  actorUserId: Schema.optional(UserId),
  threadId: Schema.optional(ThreadId),
  result: Schema.optional(WorkspaceUsageAuditResult),
  cursor: Schema.optional(PageCursor),
  limit: Schema.optional(PageLimitQuerySchema),
});

export const WorkspaceUsageAuditEventDataSchema = Schema.Struct({
  id: WorkspaceUsageAuditId,
  actorUserId: UserId,
  actorName: Schema.String,
  reason: WorkspacePrivateThreadInspectionReason,
  targetThreadId: ThreadId,
  occurredAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
  result: WorkspaceUsageAuditResult,
});

export const ListWorkspaceUsageAuditResponseSchema = successResponse(
  Schema.Struct({
    items: Schema.Array(WorkspaceUsageAuditEventDataSchema),
    nextCursor: Schema.optional(PageCursor),
    retentionDays: Schema.Literal(365),
  }),
);

export const WorkspaceUsageAuditExportDataSchema = Schema.Struct({
  filename: Schema.String,
  contentType: Schema.Literal("text/csv;charset=utf-8"),
  content: Schema.String,
  rows: Schema.Int,
  nextCursor: Schema.optional(PageCursor),
});

export const ExportWorkspaceUsageAuditResponseSchema = successResponse(
  WorkspaceUsageAuditExportDataSchema,
);

export const WorkspaceUsageInvalidRequestResponseSchema = errorResponse(
  "INVALID_WORKSPACE_USAGE_REQUEST",
  "Workspace usage request validation failed.",
);

export const WorkspaceUsageScopeForbiddenResponseSchema = errorResponse(
  "SETTINGS_SCOPE_FORBIDDEN",
  "The settings scope is unavailable for this user.",
);

export const WorkspaceUsagePermissionForbiddenResponseSchema = errorResponse(
  "WORKSPACE_PERMISSION_FORBIDDEN",
  "This workspace usage action is not permitted.",
);

export const WorkspaceUsageResourceForbiddenResponseSchema = errorResponse(
  "USAGE_RESOURCE_FORBIDDEN",
  "The requested usage resource is unavailable in this workspace.",
);

export const WorkspacePrivateInspectionForbiddenResponseSchema = errorResponse(
  "PRIVATE_THREAD_INSPECTION_FORBIDDEN",
  "Private Thread inspection requires the explicit Auditor role.",
);

export const WorkspacePrivateInspectionUnavailableResponseSchema =
  errorResponse(
    "PRIVATE_THREAD_INSPECTION_UNAVAILABLE",
    "The requested private Thread is unavailable for inspection.",
  );

export const WorkspaceUsageBrowserSessionRequiredResponseSchema = errorResponse(
  "BROWSER_SESSION_REQUIRED",
  "A browser session is required for private Thread inspection.",
);

export const WorkspaceUsagePersistenceUnavailableResponseSchema = errorResponse(
  "PERSISTENCE_UNAVAILABLE",
  "Workspace usage is temporarily unavailable.",
);

export const WorkspaceUsageErrorResponseSchema = Schema.Union([
  WorkspaceUsageInvalidRequestResponseSchema,
  WorkspaceUsageScopeForbiddenResponseSchema,
  WorkspaceUsagePermissionForbiddenResponseSchema,
  WorkspaceUsageResourceForbiddenResponseSchema,
  WorkspacePrivateInspectionForbiddenResponseSchema,
  WorkspacePrivateInspectionUnavailableResponseSchema,
  WorkspaceUsageBrowserSessionRequiredResponseSchema,
  WorkspaceUsagePersistenceUnavailableResponseSchema,
]);

export type WorkspaceUsageData = typeof WorkspaceUsageDataSchema.Type;
export type WorkspaceUsageQuery = typeof WorkspaceUsageQuerySchema.Type;
export type WorkspacePrivateThreadInspectionData =
  typeof WorkspacePrivateThreadInspectionDataSchema.Type;
export type WorkspaceUsageAuditEventData =
  typeof WorkspaceUsageAuditEventDataSchema.Type;
export type WorkspaceUsageAuditPageData =
  typeof ListWorkspaceUsageAuditResponseSchema.Type.data;
export type WorkspaceUsageAuditExportData =
  typeof WorkspaceUsageAuditExportDataSchema.Type;
