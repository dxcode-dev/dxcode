import { WORKSPACE_CONTENT_SUMMARY_UNAVAILABLE_REASON } from "@dx/api";
import {
  normalizeWorkspacePrivateThreadInspectionReason,
  normalizeWorkspaceUsageAuditQuery,
  normalizeWorkspaceUsageQuery,
  type Principal,
  type ThreadId,
  UsageRepository,
  WORKSPACE_USAGE_AUDIT_RETENTION_DAYS,
  type WorkspacePermission,
  WorkspacePermissionForbidden,
  WorkspacePrivateThreadInspectionForbidden,
  WorkspacePrivateThreadInspectionUnavailable,
  type WorkspaceSlug,
  WorkspaceUsageAuditId,
  type WorkspaceUsageAuditQueryType,
  WorkspaceUsageAuditRepository,
  type WorkspaceUsageAuditResultType,
  type WorkspaceUsageQueryType,
  workspaceRoleHasPermission,
} from "@dx/domain";
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect";
import { SettingsService } from "../service.js";
import { csvCell } from "./service.js";

interface WorkspaceUsageServiceShape {
  readonly get: ReturnType<typeof makeGet>;
  readonly exportCsv: ReturnType<typeof makeExportCsv>;
  readonly inspectPrivateThread: ReturnType<typeof makeInspectPrivateThread>;
  readonly listAudit: ReturnType<typeof makeListAudit>;
  readonly exportAuditCsv: ReturnType<typeof makeExportAuditCsv>;
}

export class WorkspaceUsageService extends Context.Service<
  WorkspaceUsageService,
  WorkspaceUsageServiceShape
>()("@dx/core/settings/usage/WorkspaceUsageService") {
  static readonly layer = Layer.effect(
    WorkspaceUsageService,
    Effect.gen(function* () {
      const settings = yield* SettingsService;
      const usage = yield* UsageRepository;
      const audit = yield* WorkspaceUsageAuditRepository;
      return WorkspaceUsageService.of({
        get: makeGet(settings, usage),
        exportCsv: makeExportCsv(settings, usage),
        inspectPrivateThread: makeInspectPrivateThread(settings, audit),
        listAudit: makeListAudit(settings, audit),
        exportAuditCsv: makeExportAuditCsv(settings, audit),
      });
    }),
  );
}

const authorize = Effect.fn("WorkspaceUsageService.authorize")(function* (
  settings: SettingsService["Service"],
  principal: Principal,
  workspaceSlug: WorkspaceSlug,
  permission: WorkspacePermission,
) {
  const membership = (yield* settings.workspace(principal, workspaceSlug))
    .workspace;
  if (
    membership.workspace.lifecycleState !== "active" ||
    !workspaceRoleHasPermission(membership.role, permission)
  ) {
    return yield* new WorkspacePermissionForbidden({ permission });
  }
  return membership;
});

const makeGet = (
  settings: SettingsService["Service"],
  usage: UsageRepository["Service"],
) =>
  Effect.fn("WorkspaceUsageService.get")(function* (
    principal: Principal,
    workspaceSlug: WorkspaceSlug,
    query: WorkspaceUsageQueryType,
  ) {
    const membership = yield* authorize(
      settings,
      principal,
      workspaceSlug,
      "usage:read",
    );
    const normalized = yield* normalizeWorkspaceUsageQuery(query);
    const dashboard = yield* usage.workspaceDashboard(
      membership.workspace.id,
      normalized,
    );
    return {
      ...dashboard,
      privateInspection: {
        permitted:
          membership.role === "auditor" &&
          workspaceRoleHasPermission(
            membership.role,
            "private-threads:inspect",
          ),
        requiredRole: "auditor" as const,
        contentSummary: {
          available: false as const,
          reason: WORKSPACE_CONTENT_SUMMARY_UNAVAILABLE_REASON,
        },
      },
    };
  });

const makeExportCsv = (
  settings: SettingsService["Service"],
  usage: UsageRepository["Service"],
) =>
  Effect.fn("WorkspaceUsageService.exportCsv")(function* (
    principal: Principal,
    workspaceSlug: WorkspaceSlug,
    query: WorkspaceUsageQueryType,
  ) {
    const membership = yield* authorize(
      settings,
      principal,
      workspaceSlug,
      "usage:read",
    );
    const normalized = yield* normalizeWorkspaceUsageQuery({
      ...query,
      ranking: "users",
      cursor: undefined,
      limit: 1,
    });
    const dashboard = yield* usage.workspaceDashboard(
      membership.workspace.id,
      normalized,
    );
    const header = [
      "day",
      "timezone",
      "total_tokens",
      "unknown_token_events",
      "estimated_cost_usd_micros",
      "unknown_cost_events",
      "average_latency_ms",
      "runner_lifecycle_duration_ms",
      "model_turns",
    ];
    const rows = dashboard.daily.map((day) => [
      day.day,
      dashboard.range.timezone,
      day.totalTokens,
      day.unknownTokenEvents,
      day.estimatedCostMicros,
      day.unknownCostEvents,
      day.averageLatencyMs ?? "unknown",
      day.runnerDurationMs,
      day.modelTurns,
    ]);
    return {
      filename: `dx-workspace-${workspaceSlug}-usage-${dashboard.range.from}-${dashboard.range.to}.csv`,
      contentType: "text/csv;charset=utf-8" as const,
      content: [header, ...rows]
        .map((row) => row.map(csvCell).join(","))
        .join("\r\n"),
      rows: rows.length,
      timezone: dashboard.range.timezone,
      estimated: true as const,
    };
  });

const makeAuditEvent = Effect.fn("WorkspaceUsageService.makeAuditEvent")(
  function* (input: {
    readonly workspaceId: import("@dx/domain").WorkspaceId;
    readonly actorUserId: import("@dx/domain").UserId;
    readonly reason: import("@dx/domain").WorkspacePrivateThreadInspectionReasonType;
    readonly targetThreadId: ThreadId;
    readonly result: WorkspaceUsageAuditResultType;
  }) {
    const occurredAt = yield* DateTime.now;
    const id = yield* Schema.decodeUnknownEffect(WorkspaceUsageAuditId)(
      crypto.randomUUID(),
    );
    return {
      id,
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      reason: input.reason,
      targetThreadId: input.targetThreadId,
      occurredAt,
      expiresAt: DateTime.makeUnsafe(
        DateTime.toEpochMillis(occurredAt) +
          WORKSPACE_USAGE_AUDIT_RETENTION_DAYS * 86_400_000,
      ),
      result: input.result,
    };
  },
);

const makeInspectPrivateThread = (
  settings: SettingsService["Service"],
  audit: WorkspaceUsageAuditRepository["Service"],
) =>
  Effect.fn("WorkspaceUsageService.inspectPrivateThread")(function* (
    principal: Principal,
    workspaceSlug: WorkspaceSlug,
    input: { readonly threadId: ThreadId; readonly reason: string },
  ) {
    const reason = yield* normalizeWorkspacePrivateThreadInspectionReason(
      input.reason,
    );
    const membership = (yield* settings.workspace(principal, workspaceSlug))
      .workspace;
    const append = Effect.fn("WorkspaceUsageService.appendInspectionAudit")(
      function* (result: WorkspaceUsageAuditResultType) {
        const event = yield* makeAuditEvent({
          workspaceId: membership.workspace.id,
          actorUserId: principal.userId,
          reason,
          targetThreadId: input.threadId,
          result,
        });
        yield* audit.append(event);
        return event;
      },
    );

    if (
      membership.workspace.lifecycleState !== "active" ||
      membership.role !== "auditor" ||
      !workspaceRoleHasPermission(membership.role, "private-threads:inspect")
    ) {
      yield* append("permission_denied");
      return yield* new WorkspacePrivateThreadInspectionForbidden();
    }

    const target = yield* audit.findInspectionTarget(
      membership.workspace.id,
      input.threadId,
    );
    if (Option.isNone(target) || target.value.lifecycle === "deleted") {
      yield* append("thread_unavailable");
      return yield* new WorkspacePrivateThreadInspectionUnavailable();
    }
    if (target.value.visibility !== "private") {
      yield* append("thread_not_private");
      return yield* new WorkspacePrivateThreadInspectionUnavailable();
    }

    const event = yield* append("success");
    const { ownerUserId: _, ...thread } = target.value;
    return {
      auditId: event.id,
      auditedAt: event.occurredAt,
      thread,
      contentSummary: {
        status: "unavailable" as const,
        reason: WORKSPACE_CONTENT_SUMMARY_UNAVAILABLE_REASON,
      },
    };
  });

const makeListAudit = (
  settings: SettingsService["Service"],
  audit: WorkspaceUsageAuditRepository["Service"],
) =>
  Effect.fn("WorkspaceUsageService.listAudit")(function* (
    principal: Principal,
    workspaceSlug: WorkspaceSlug,
    query: WorkspaceUsageAuditQueryType,
  ) {
    const membership = yield* authorize(
      settings,
      principal,
      workspaceSlug,
      "usage-audit:read",
    );
    const normalized = yield* normalizeWorkspaceUsageAuditQuery(query);
    const page = yield* audit.list(membership.workspace.id, normalized);
    return { ...page, retentionDays: WORKSPACE_USAGE_AUDIT_RETENTION_DAYS };
  });

const makeExportAuditCsv = (
  settings: SettingsService["Service"],
  audit: WorkspaceUsageAuditRepository["Service"],
) =>
  Effect.fn("WorkspaceUsageService.exportAuditCsv")(function* (
    principal: Principal,
    workspaceSlug: WorkspaceSlug,
    query: WorkspaceUsageAuditQueryType,
  ) {
    const membership = yield* authorize(
      settings,
      principal,
      workspaceSlug,
      "usage-audit:read",
    );
    const normalized = yield* normalizeWorkspaceUsageAuditQuery(query);
    const page = yield* audit.list(membership.workspace.id, normalized);
    const rows = page.items.map((event) => [
      Schema.encodeSync(Schema.DateTimeUtcFromString)(event.occurredAt),
      event.actorUserId,
      event.actorName,
      event.targetThreadId,
      event.reason,
      event.result,
      Schema.encodeSync(Schema.DateTimeUtcFromString)(event.expiresAt),
    ]);
    return {
      filename: `dx-workspace-${workspaceSlug}-private-thread-audit-${query.from}-${query.to}.csv`,
      contentType: "text/csv;charset=utf-8" as const,
      content: [
        [
          "occurred_at",
          "actor_user_id",
          "actor_name",
          "target_thread_id",
          "reason",
          "result",
          "expires_at",
        ],
        ...rows,
      ]
        .map((row) => row.map(csvCell).join(","))
        .join("\r\n"),
      rows: rows.length,
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    };
  });
