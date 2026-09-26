import { Effect, Schema } from "effect";
import { PageCursor } from "../pagination/cursor.js";
import { ProjectId } from "../projects/project-id.js";
import { ModelProviderId } from "../settings/model-routing.js";
import type { WorkspaceId } from "../settings/workspace.js";
import { ThreadId } from "../threads/thread-id.js";
import { UserId } from "../users/user-id.js";
import {
  DEFAULT_USAGE_PAGE_LIMIT,
  InvalidUsageQuery,
  type NormalizedUsageQuery,
  normalizeUsageQuery,
  UsageDate,
  UsageModelId,
} from "./usage.js";

export const WORKSPACE_USAGE_AUDIT_RETENTION_DAYS = 365;
export const MAX_PRIVATE_THREAD_INSPECTION_REASON_LENGTH = 500;

export const WorkspaceUsageRanking = Schema.Literals(["users", "projects"]);

export type WorkspaceUsageRanking = typeof WorkspaceUsageRanking.Type;

export const WorkspaceUsageQuery = Schema.Struct({
  from: UsageDate,
  to: UsageDate,
  timezoneOffsetMinutes: Schema.Int.check(
    Schema.isBetween({ minimum: -840, maximum: 840 }),
  ),
  userId: Schema.optional(UserId),
  projectId: Schema.optional(ProjectId),
  providerId: Schema.optional(ModelProviderId),
  modelId: Schema.optional(UsageModelId),
  ranking: Schema.optional(WorkspaceUsageRanking),
  cursor: Schema.optional(PageCursor),
  limit: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
  ),
});

export type WorkspaceUsageQuery = typeof WorkspaceUsageQuery.Type;

export interface NormalizedWorkspaceUsageQuery extends NormalizedUsageQuery {
  readonly userId?: UserId;
  readonly ranking: WorkspaceUsageRanking;
}

export const normalizeWorkspaceUsageQuery = Effect.fn(
  "normalizeWorkspaceUsageQuery",
)(function* (query: WorkspaceUsageQuery) {
  const normalized = yield* normalizeUsageQuery(query);
  return {
    ...normalized,
    ...(query.userId === undefined ? {} : { userId: query.userId }),
    ranking: query.ranking ?? "users",
  } satisfies NormalizedWorkspaceUsageQuery;
});

const WorkspaceUsageRankingCursorPayload = Schema.Struct({
  v: Schema.Literal(1),
  ranking: WorkspaceUsageRanking,
  estimatedCostMicros: Schema.Int,
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
});

const WorkspaceUsageRankingCursorCodec = Schema.StringFromBase64Url.pipe(
  Schema.decodeTo(Schema.fromJsonString(WorkspaceUsageRankingCursorPayload)),
);

export interface WorkspaceUsageRankingCursorPosition {
  readonly ranking: WorkspaceUsageRanking;
  readonly estimatedCostMicros: number;
  readonly id: string;
}

export const encodeWorkspaceUsageRankingCursor = (
  position: WorkspaceUsageRankingCursorPosition,
) =>
  Schema.encodeEffect(WorkspaceUsageRankingCursorCodec)({
    v: 1,
    ...position,
  }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(PageCursor)));

export const decodeWorkspaceUsageRankingCursor = (
  cursor: PageCursor,
  ranking: WorkspaceUsageRanking,
): Effect.Effect<WorkspaceUsageRankingCursorPosition, InvalidUsageQuery> =>
  Schema.decodeUnknownEffect(WorkspaceUsageRankingCursorCodec)(cursor).pipe(
    Effect.flatMap((position) =>
      position.ranking === ranking
        ? Effect.succeed({
            ranking: position.ranking,
            estimatedCostMicros: position.estimatedCostMicros,
            id: position.id,
          })
        : Effect.fail(new InvalidUsageQuery({ reason: "cursor" })),
    ),
    Effect.mapError(() => new InvalidUsageQuery({ reason: "cursor" })),
  );

export const WorkspacePrivateThreadInspectionReason = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_PRIVATE_THREAD_INSPECTION_REASON_LENGTH),
).pipe(Schema.brand("@dx/WorkspacePrivateThreadInspectionReason"));

export type WorkspacePrivateThreadInspectionReason =
  typeof WorkspacePrivateThreadInspectionReason.Type;

export class InvalidWorkspacePrivateThreadInspectionReason extends Schema.TaggedError<InvalidWorkspacePrivateThreadInspectionReason>()(
  "InvalidWorkspacePrivateThreadInspectionReason",
  {},
) {}

export const normalizeWorkspacePrivateThreadInspectionReason = (
  value: string,
): Effect.Effect<
  WorkspacePrivateThreadInspectionReason,
  InvalidWorkspacePrivateThreadInspectionReason
> =>
  Schema.decodeUnknownEffect(WorkspacePrivateThreadInspectionReason)(
    value.trim(),
  ).pipe(
    Effect.mapError(() => new InvalidWorkspacePrivateThreadInspectionReason()),
  );

export const WorkspaceThreadVisibility = Schema.Literals([
  "private",
  "workspace",
]);

export type WorkspaceThreadVisibility = typeof WorkspaceThreadVisibility.Type;

export const WorkspaceThreadLifecycle = Schema.Literals([
  "active",
  "archived",
  "deleted",
]);

export type WorkspaceThreadLifecycle = typeof WorkspaceThreadLifecycle.Type;

export const WorkspaceUsageAuditResult = Schema.Literals([
  "success",
  "permission_denied",
  "browser_session_required",
  "recent_authentication_required",
  "thread_unavailable",
  "thread_not_private",
]);

export type WorkspaceUsageAuditResult = typeof WorkspaceUsageAuditResult.Type;

export const WorkspaceUsageAuditId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
).pipe(Schema.brand("@dx/WorkspaceUsageAuditId"));

export type WorkspaceUsageAuditId = typeof WorkspaceUsageAuditId.Type;

export const WorkspaceUsageAuditQuery = Schema.Struct({
  from: UsageDate,
  to: UsageDate,
  actorUserId: Schema.optional(UserId),
  threadId: Schema.optional(ThreadId),
  result: Schema.optional(WorkspaceUsageAuditResult),
  cursor: Schema.optional(PageCursor),
  limit: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
  ),
});

export type WorkspaceUsageAuditQuery = typeof WorkspaceUsageAuditQuery.Type;

export interface NormalizedWorkspaceUsageAuditQuery
  extends WorkspaceUsageAuditQuery {
  readonly fromInclusive: string;
  readonly toExclusive: string;
  readonly limit: number;
}

export const normalizeWorkspaceUsageAuditQuery = Effect.fn(
  "normalizeWorkspaceUsageAuditQuery",
)(function* (query: WorkspaceUsageAuditQuery) {
  const normalized = yield* normalizeUsageQuery({
    from: query.from,
    to: query.to,
    timezoneOffsetMinutes: 0,
    cursor: query.cursor,
    limit: query.limit,
  });
  return {
    ...query,
    fromInclusive: normalized.fromInclusive,
    toExclusive: normalized.toExclusive,
    limit: query.limit ?? DEFAULT_USAGE_PAGE_LIMIT,
  } satisfies NormalizedWorkspaceUsageAuditQuery;
});

const WorkspaceUsageAuditCursorPayload = Schema.Struct({
  v: Schema.Literal(1),
  occurredAt: Schema.DateTimeUtcFromString,
  id: WorkspaceUsageAuditId,
});

const WorkspaceUsageAuditCursorCodec = Schema.StringFromBase64Url.pipe(
  Schema.decodeTo(Schema.fromJsonString(WorkspaceUsageAuditCursorPayload)),
);

export interface WorkspaceUsageAuditCursorPosition {
  readonly occurredAt: typeof Schema.DateTimeUtc.Type;
  readonly id: WorkspaceUsageAuditId;
}

export const encodeWorkspaceUsageAuditCursor = (
  position: WorkspaceUsageAuditCursorPosition,
) =>
  Schema.encodeEffect(WorkspaceUsageAuditCursorCodec)({
    v: 1,
    ...position,
  }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(PageCursor)));

export const decodeWorkspaceUsageAuditCursor = (
  cursor: PageCursor,
): Effect.Effect<WorkspaceUsageAuditCursorPosition, InvalidUsageQuery> =>
  Schema.decodeUnknownEffect(WorkspaceUsageAuditCursorCodec)(cursor).pipe(
    Effect.map(({ occurredAt, id }) => ({ occurredAt, id })),
    Effect.mapError(() => new InvalidUsageQuery({ reason: "cursor" })),
  );

export class WorkspacePrivateThreadInspectionForbidden extends Schema.TaggedError<WorkspacePrivateThreadInspectionForbidden>()(
  "WorkspacePrivateThreadInspectionForbidden",
  {},
) {}

export class WorkspacePrivateThreadInspectionUnavailable extends Schema.TaggedError<WorkspacePrivateThreadInspectionUnavailable>()(
  "WorkspacePrivateThreadInspectionUnavailable",
  {},
) {}

export interface WorkspacePrivateThreadTarget {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly projectName: string;
  readonly ownerUserId: UserId;
  readonly visibility: WorkspaceThreadVisibility;
  readonly lifecycle: WorkspaceThreadLifecycle;
  readonly createdAt: typeof Schema.DateTimeUtc.Type;
  readonly updatedAt: typeof Schema.DateTimeUtc.Type;
  readonly usage: {
    readonly totalTokens: number;
    readonly unknownTokenEvents: number;
    readonly modelTurns: number;
    readonly averageLatencyMs: number | null;
    readonly runnerDurationMs: number;
    readonly firstObservedAt: typeof Schema.DateTimeUtc.Type | null;
    readonly lastObservedAt: typeof Schema.DateTimeUtc.Type | null;
  };
}

export interface WorkspacePrivateThreadInspection {
  readonly auditId: WorkspaceUsageAuditId;
  readonly auditedAt: typeof Schema.DateTimeUtc.Type;
  readonly thread: Omit<WorkspacePrivateThreadTarget, "ownerUserId">;
  readonly contentSummary: {
    readonly status: "unavailable";
    readonly reason: string;
  };
}

export interface WorkspaceUsageAuditEvent {
  readonly id: WorkspaceUsageAuditId;
  readonly workspaceId: WorkspaceId;
  readonly actorUserId: UserId;
  readonly actorName: string;
  readonly reason: WorkspacePrivateThreadInspectionReason;
  readonly targetThreadId: ThreadId;
  readonly occurredAt: typeof Schema.DateTimeUtc.Type;
  readonly expiresAt: typeof Schema.DateTimeUtc.Type;
  readonly result: WorkspaceUsageAuditResult;
}
