import {
  PersistenceUnavailable,
  Principal,
  ProjectId,
  ThreadId,
  UsageRepository,
  UserId,
  WorkspaceId,
  WorkspaceMembership,
  WorkspacePrivateThreadInspectionForbidden,
  WorkspacePrivateThreadInspectionUnavailable,
  WorkspaceRepository,
  type WorkspaceRole,
  WorkspaceUsageAuditRepository,
  type WorkspaceUsageAuditResultType,
} from "@dx/domain";
import { Effect, Layer, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { SettingsService } from "../service.js";
import { WorkspaceUsageService } from "./workspace-service.js";

const principal = Schema.decodeUnknownSync(Principal)({
  userId: "workspace-usage-actor",
  credentialScopes: ["personal", "workspace"],
});
const workspaceId = Schema.decodeUnknownSync(WorkspaceId)(
  "workspace-usage-service",
);
const workspaceSlug = "workspace-usage-service" as never;
const threadId = Schema.decodeUnknownSync(ThreadId)(
  "thr_00000000-0000-4000-8000-000000000042",
);
const projectId = Schema.decodeUnknownSync(ProjectId)(
  "prj_00000000-0000-4000-8000-000000000042",
);
const ownerUserId = Schema.decodeUnknownSync(UserId)("private-thread-owner");
const instant = Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)(
  "2026-08-23T01:00:00.000Z",
);

const membershipFor = (role: WorkspaceRole) =>
  Schema.decodeUnknownSync(WorkspaceMembership)({
    workspace: {
      id: workspaceId,
      displayName: "Usage Workspace",
      shortName: workspaceSlug,
      lifecycleState: "active",
      revision: 0,
    },
    userId: principal.userId,
    role,
  });

const target = (
  visibility: "private" | "workspace" = "private",
  lifecycle: "active" | "archived" | "deleted" = "active",
) => ({
  threadId,
  projectId,
  projectName: "Incident project",
  ownerUserId,
  visibility,
  lifecycle,
  createdAt: instant,
  updatedAt: instant,
  usage: {
    totalTokens: 42,
    unknownTokenEvents: 1,
    modelTurns: 2,
    averageLatencyMs: 125,
    runnerDurationMs: 300,
    firstObservedAt: instant,
    lastObservedAt: instant,
  },
});

interface LayerOptions {
  readonly role?: WorkspaceRole;
  readonly target?: ReturnType<typeof target> | undefined;
  readonly auditResults?: Array<WorkspaceUsageAuditResultType>;
  readonly failAudit?: boolean;
}

const layerFor = (options: LayerOptions = {}) => {
  const membership = membershipFor(options.role ?? "auditor");
  const workspaceRepository = Layer.succeed(
    WorkspaceRepository,
    WorkspaceRepository.of({
      findByUser: () => Effect.succeed(Option.some(membership)),
      createOwnedByUser: () => Effect.die("not used"),
      updateProfile: () => Effect.die("not used"),
    }),
  );
  const settings = SettingsService.layer.pipe(
    Layer.provide(workspaceRepository),
  );
  const usage = Layer.succeed(
    UsageRepository,
    UsageRepository.of({
      record: () => Effect.die("not used"),
      putPrice: () => Effect.die("not used"),
      dashboard: () => Effect.die("not used"),
      workspaceDashboard: () => Effect.die("not used"),
    }),
  );
  const audit = Layer.succeed(
    WorkspaceUsageAuditRepository,
    WorkspaceUsageAuditRepository.of({
      findInspectionTarget: () =>
        Effect.succeed(Option.fromNullishOr(options.target ?? target())),
      append: (event) =>
        options.failAudit
          ? Effect.fail(
              PersistenceUnavailable.new(
                { operation: "workspaceUsageAudit.append" },
                new Error("unavailable"),
              ),
            )
          : Effect.sync(() => options.auditResults?.push(event.result)),
      list: () => Effect.die("not used"),
    }),
  );
  return WorkspaceUsageService.layer.pipe(
    Layer.provide(Layer.mergeAll(settings, usage, audit)),
  );
};

const inspect = (
  layer: Layer.Layer<WorkspaceUsageService>,
  reason = "Incident 42",
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* WorkspaceUsageService;
      return yield* service.inspectPrivateThread(principal, workspaceSlug, {
        threadId,
        reason,
      });
    }).pipe(Effect.provide(layer)),
  );

describe("WorkspaceUsageService private inspection", () => {
  it("requires the explicit Auditor role and records the denied outcome", async () => {
    const results: Array<WorkspaceUsageAuditResultType> = [];
    await expect(
      inspect(layerFor({ role: "admin", auditResults: results })),
    ).rejects.toBeInstanceOf(WorkspacePrivateThreadInspectionForbidden);
    expect(results).toEqual(["permission_denied"]);
  });

  it("rejects empty reasons before inspecting or auditing a target", async () => {
    const results: Array<WorkspaceUsageAuditResultType> = [];
    await expect(
      inspect(layerFor({ auditResults: results }), "   "),
    ).rejects.toMatchObject({
      _tag: "InvalidWorkspacePrivateThreadInspectionReason",
    });
    expect(results).toEqual([]);
  });

  it("returns only existing metadata and content-free usage after the success audit", async () => {
    const results: Array<WorkspaceUsageAuditResultType> = [];
    const inspection = await inspect(
      layerFor({
        target: target("private", "archived"),
        auditResults: results,
      }),
    );

    expect(results).toEqual(["success"]);
    expect(inspection.thread).toMatchObject({
      threadId,
      lifecycle: "archived",
      usage: { totalTokens: 42, unknownTokenEvents: 1 },
    });
    expect(inspection.contentSummary).toMatchObject({ status: "unavailable" });
    expect(inspection.thread).not.toHaveProperty("prompt");
    expect(inspection.thread).not.toHaveProperty("response");
    expect(inspection.thread).not.toHaveProperty("messages");
  });

  it.each([
    ["workspace", "active", "thread_not_private"],
    ["private", "deleted", "thread_unavailable"],
  ] as const)(
    "does not return %s/%s Thread metadata and records %s",
    async (visibility, lifecycle, result) => {
      const results: Array<WorkspaceUsageAuditResultType> = [];
      await expect(
        inspect(
          layerFor({
            target: target(visibility, lifecycle),
            auditResults: results,
          }),
        ),
      ).rejects.toBeInstanceOf(WorkspacePrivateThreadInspectionUnavailable);
      expect(results).toEqual([result]);
    },
  );

  it("returns no protected data when the immutable success audit cannot persist", async () => {
    await expect(inspect(layerFor({ failAudit: true }))).rejects.toBeInstanceOf(
      PersistenceUnavailable,
    );
  });
});
