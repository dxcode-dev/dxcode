import { Context, type DateTime, type Effect, type Schema } from "effect";
import type { PageCursor } from "../pagination/cursor.js";
import type { PersistenceUnavailable } from "../persistence/errors.js";
import type { ProjectId } from "../projects/project-id.js";
import type { ModelProviderId } from "../settings/model-routing.js";
import type { WorkspaceId } from "../settings/workspace.js";
import type { ThreadId } from "../threads/thread-id.js";
import type { UserId } from "../users/user-id.js";
import type {
  InvalidUsageQuery,
  NormalizedUsageQuery,
  UsageEventInput,
  UsageModelId,
  UsagePriceMetadata,
  UsageResourceForbidden,
} from "./usage.js";
import type { NormalizedWorkspaceUsageQuery } from "./workspace-usage.js";

export interface UsageSummary {
  readonly tokens: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly reasoning: number | null;
    readonly total: number;
    readonly unknownEvents: number;
  };
  readonly estimatedCost: {
    readonly amountMicros: number;
    readonly currency: "USD";
    readonly estimated: true;
    readonly knownEvents: number;
    readonly unknownEvents: number;
  };
  readonly modelTurns: number;
  readonly averageLatencyMs: number | null;
  readonly toolDurationMs: number;
  readonly runnerDurationMs: number;
  readonly outcomes: {
    readonly success: number;
    readonly error: number;
    readonly cancelled: number;
    readonly unknown: number;
  };
}

export interface UsageDailyTrend {
  readonly day: string;
  readonly totalTokens: number;
  readonly unknownTokenEvents: number;
  readonly estimatedCostMicros: number;
  readonly unknownCostEvents: number;
  readonly averageLatencyMs: number | null;
  readonly runnerDurationMs: number;
  readonly modelTurns: number;
}

export interface UsageThreadAggregate {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly projectName: string;
  readonly createdAt: DateTime.Utc;
  readonly providerId: ModelProviderId;
  readonly modelId: UsageModelId;
  readonly profileId: string;
  readonly profileVersion: number;
  readonly totalTokens: number;
  readonly unknownTokenEvents: number;
  readonly estimatedCostMicros: number;
  readonly unknownCostEvents: number;
  readonly averageLatencyMs: number | null;
  readonly runnerDurationMs: number;
  readonly modelTurns: number;
  readonly errorEvents: number;
}

export interface UsageUserAggregate {
  readonly userId: UserId;
  readonly userName: string;
  readonly totalTokens: number;
  readonly unknownTokenEvents: number;
  readonly estimatedCostMicros: number;
  readonly unknownCostEvents: number;
  readonly averageLatencyMs: number | null;
  readonly runnerDurationMs: number;
  readonly modelTurns: number;
  readonly errorEvents: number;
}

export interface UsageProjectAggregate {
  readonly projectId: ProjectId;
  readonly projectName: string;
  readonly ownerUserId: UserId;
  readonly ownerName: string;
  readonly totalTokens: number;
  readonly unknownTokenEvents: number;
  readonly estimatedCostMicros: number;
  readonly unknownCostEvents: number;
  readonly averageLatencyMs: number | null;
  readonly runnerDurationMs: number;
  readonly modelTurns: number;
  readonly errorEvents: number;
}

export interface UsageRunnerAggregate {
  readonly provider: "e2b";
  readonly profileId: string | null;
  readonly profileVersion: number | null;
  readonly template: string;
  readonly cpuCores: number | null;
  readonly memoryMb: number | null;
  readonly diskGb: number | null;
  readonly durationMs: number;
  readonly events: number;
  readonly unknownResourceEvents: number;
}

export interface UsagePriceSourceSummary {
  readonly source: "deployment" | "catalog";
  readonly sourceVersion: string;
  readonly currency: "USD";
  readonly effectiveFrom: DateTime.Utc;
  readonly effectiveTo: DateTime.Utc | null;
  readonly freshUntil: DateTime.Utc;
  readonly estimated: true;
}

export interface UsageDashboard {
  readonly range: {
    readonly from: string;
    readonly to: string;
    readonly timezoneOffsetMinutes: number;
    readonly timezone: string;
  };
  readonly filters: {
    readonly projectId?: ProjectId;
    readonly threadId?: ThreadId;
    readonly providerId?: ModelProviderId;
    readonly modelId?: UsageModelId;
  };
  readonly summary: UsageSummary;
  readonly daily: ReadonlyArray<UsageDailyTrend>;
  readonly threads: ReadonlyArray<UsageThreadAggregate>;
  readonly runners: ReadonlyArray<UsageRunnerAggregate>;
  readonly priceSources: ReadonlyArray<UsagePriceSourceSummary>;
  readonly nextCursor?: PageCursor;
}

export type WorkspaceUsageRankingPage =
  | {
      readonly kind: "users";
      readonly items: ReadonlyArray<UsageUserAggregate>;
      readonly nextCursor?: PageCursor;
    }
  | {
      readonly kind: "projects";
      readonly items: ReadonlyArray<UsageProjectAggregate>;
      readonly nextCursor?: PageCursor;
    };

export interface WorkspaceUsageDashboard {
  readonly range: UsageDashboard["range"];
  readonly filters: UsageDashboard["filters"] & {
    readonly userId?: UserId;
  };
  readonly summary: UsageSummary;
  readonly daily: ReadonlyArray<UsageDailyTrend>;
  readonly ranking: WorkspaceUsageRankingPage;
  readonly runners: ReadonlyArray<UsageRunnerAggregate>;
  readonly priceSources: ReadonlyArray<UsagePriceSourceSummary>;
}

export type UsageRepositoryError =
  | InvalidUsageQuery
  | UsageResourceForbidden
  | PersistenceUnavailable
  | Schema.SchemaError;

export interface UsageRepositoryShape {
  readonly record: (
    event: UsageEventInput,
    price?: UsagePriceMetadata,
  ) => Effect.Effect<void, PersistenceUnavailable | Schema.SchemaError>;
  readonly putPrice: (
    price: UsagePriceMetadata,
  ) => Effect.Effect<void, PersistenceUnavailable | Schema.SchemaError>;
  readonly dashboard: (
    ownerUserId: UserId,
    query: NormalizedUsageQuery,
  ) => Effect.Effect<UsageDashboard, UsageRepositoryError>;
  readonly workspaceDashboard: (
    workspaceId: WorkspaceId,
    query: NormalizedWorkspaceUsageQuery,
  ) => Effect.Effect<WorkspaceUsageDashboard, UsageRepositoryError>;
}

export class UsageRepository extends Context.Service<
  UsageRepository,
  UsageRepositoryShape
>()("@dx/domain/usage/UsageRepository") {}
