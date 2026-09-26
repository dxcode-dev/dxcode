import {
  isRemoteRunnerAdapter,
  type PersistenceUnavailable,
  type Principal,
  type RunnerProfileId,
  type SettingsMembershipInvariantViolation,
  SettingsScopeForbidden,
  type UserId,
  type WorkspacePolicy,
  type WorkspacePolicyAction,
  type WorkspacePolicyConflict,
  WorkspacePolicyDenied,
  WorkspacePolicyRepository,
  type WorkspacePolicyUpdate,
  WorkspaceRepository,
  type WorkspaceRole,
  type WorkspaceSlug,
  workspaceRoleHasPermission,
} from "@dx/domain";
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect";
import { SettingsAudit } from "../audit.js";
import { SettingsService } from "../service.js";

export class InvalidWorkspacePolicy extends Schema.TaggedError<InvalidWorkspacePolicy>()(
  "InvalidWorkspacePolicy",
  {
    reason: Schema.Literal("runner-profile-selection"),
  },
) {}

export interface WorkspacePolicyView {
  readonly policy: WorkspacePolicy;
  readonly canUpdate: boolean;
  readonly workspaceRole: WorkspaceRole;
}

type WorkspacePolicyReadError =
  | Schema.SchemaError
  | PersistenceUnavailable
  | SettingsMembershipInvariantViolation
  | SettingsScopeForbidden;

type WorkspacePolicyEvaluationError =
  | Schema.SchemaError
  | PersistenceUnavailable
  | SettingsMembershipInvariantViolation
  | WorkspacePolicyDenied;

type WorkspacePolicyMutationRejection =
  | InvalidWorkspacePolicy
  | SettingsScopeForbidden
  | WorkspacePolicyConflict;

type WorkspacePolicyUpdateError =
  | WorkspacePolicyReadError
  | WorkspacePolicyMutationRejection;

interface WorkspacePolicyServiceShape {
  readonly get: (
    principal: Principal,
    workspaceSlug: WorkspaceSlug,
  ) => Effect.Effect<WorkspacePolicyView, WorkspacePolicyReadError>;
  readonly update: (
    principal: Principal,
    workspaceSlug: WorkspaceSlug,
    input: WorkspacePolicyUpdate,
    expectedRevision: number,
    availableRunnerProfileIds: ReadonlyArray<RunnerProfileId>,
    requestId: string,
  ) => Effect.Effect<WorkspacePolicyView, WorkspacePolicyUpdateError>;
  readonly evaluateForUser: (
    userId: UserId,
    action: WorkspacePolicyAction,
  ) => Effect.Effect<void, WorkspacePolicyEvaluationError>;
}

const changedFields = (
  current: WorkspacePolicy,
  input: WorkspacePolicyUpdate,
): ReadonlyArray<string> => {
  const changed: Array<string> = [];
  for (const field of Object.keys(input.restrictions).sort() as Array<
    keyof WorkspacePolicyUpdate["restrictions"]
  >) {
    if (
      JSON.stringify(current.restrictions[field]) !==
      JSON.stringify(input.restrictions[field])
    ) {
      changed.push(`restrictions.${field}`);
    }
  }
  return changed;
};

const validateUpdate = Effect.fn("WorkspacePolicyService.validateUpdate")(
  function* (
    current: WorkspacePolicy,
    input: WorkspacePolicyUpdate,
    availableRunnerProfileIds: ReadonlyArray<RunnerProfileId>,
  ) {
    const allowed = input.restrictions.allowedRunnerProfileIds;
    const persisted = new Set(
      current.restrictions.allowedRunnerProfileIds ?? [],
    );
    if (
      allowed !== null &&
      (allowed.length === 0 ||
        new Set(allowed).size !== allowed.length ||
        allowed.some(
          (id) => !availableRunnerProfileIds.includes(id) && !persisted.has(id),
        ))
    ) {
      return yield* new InvalidWorkspacePolicy({
        reason: "runner-profile-selection",
      });
    }
  },
);

export const workspacePolicyDenial = (
  policy: WorkspacePolicy,
  action: WorkspacePolicyAction,
): WorkspacePolicyDenied | undefined => {
  const restrictions = policy.restrictions;
  switch (action.kind) {
    case "project.create":
    case "execution.admit":
      if (
        restrictions.allowedRunnerProfileIds !== null &&
        !restrictions.allowedRunnerProfileIds.includes(action.runnerProfileId)
      ) {
        return new WorkspacePolicyDenied({
          reason: "runner-profile-restricted",
        });
      }
      return !restrictions.allowRemoteRunners &&
        isRemoteRunnerAdapter(action.runnerAdapter)
        ? new WorkspacePolicyDenied({ reason: "remote-runner-disabled" })
        : undefined;
    case "provider.use-personal-override":
      return restrictions.allowPersonalProviderOverrides
        ? undefined
        : new WorkspacePolicyDenied({
            reason: "personal-provider-overrides-disabled",
          });
    case "mcp.use-personal-override":
      return restrictions.allowPersonalMcpOverrides
        ? undefined
        : new WorkspacePolicyDenied({
            reason: "personal-mcp-overrides-disabled",
          });
    case "secret.use-personal-override":
      return restrictions.allowPersonalSecretOverrides
        ? undefined
        : new WorkspacePolicyDenied({
            reason: "personal-secret-overrides-disabled",
          });
  }
};

export class WorkspacePolicyService extends Context.Service<
  WorkspacePolicyService,
  WorkspacePolicyServiceShape
>()("@dx/core/settings/workspace-policy/WorkspacePolicyService") {
  static readonly layer = Layer.effect(
    WorkspacePolicyService,
    Effect.gen(function* () {
      const policies = yield* WorkspacePolicyRepository;
      const workspaces = yield* WorkspaceRepository;
      const settings = yield* SettingsService;
      const audit = yield* SettingsAudit;

      const view = Effect.fn("WorkspacePolicyService.view")(function* (
        principal: Principal,
        workspaceSlug: WorkspaceSlug,
      ) {
        const access = yield* settings.workspace(principal, workspaceSlug);
        const policy = yield* policies.get(access.workspace.workspace.id);
        return {
          policy,
          canUpdate:
            access.workspace.workspace.lifecycleState === "active" &&
            workspaceRoleHasPermission(
              access.workspace.role,
              "workspace:update",
            ),
          workspaceRole: access.workspace.role,
        } satisfies WorkspacePolicyView;
      });

      const auditRecord = Effect.fn("WorkspacePolicyService.auditRecord")(
        function* (
          current: WorkspacePolicy,
          principal: Principal,
          requestId: string,
          outcome: "success" | "rejected",
          fields: ReadonlyArray<string>,
          reason?: string,
        ) {
          const now = yield* DateTime.now;
          const createdAt = Schema.encodeSync(Schema.DateTimeUtcFromString)(
            now,
          );
          return {
            id: `wpa_${crypto.randomUUID()}`,
            workspaceId: current.workspaceId,
            actorUserId: principal.userId,
            requestId,
            outcome,
            ...(reason === undefined ? {} : { reason }),
            previousRevision: current.revision,
            ...(outcome === "success"
              ? { nextRevision: current.revision + 1 }
              : {}),
            changedFields: fields,
            createdAt,
          } as const;
        },
      );

      const rejectMutation = Effect.fn("WorkspacePolicyService.rejectMutation")(
        function* (
          current: WorkspacePolicy,
          principal: Principal,
          requestId: string,
          fields: ReadonlyArray<string>,
          reason: string,
          error: WorkspacePolicyMutationRejection,
        ) {
          const record = yield* auditRecord(
            current,
            principal,
            requestId,
            "rejected",
            fields,
            reason,
          );
          yield* policies.recordRejected(record);
          yield* audit.record({
            action: "workspace_policy.update",
            scope: "workspace",
            outcome: "rejected",
            requestId,
            userId: principal.userId,
            workspaceId: current.workspaceId,
          });
          return yield* Effect.fail(error);
        },
      );

      const evaluate = Effect.fn("WorkspacePolicyService.evaluate")(function* (
        userId: UserId,
        action: WorkspacePolicyAction,
      ) {
        const membership = yield* workspaces.findByUser(userId);
        if (Option.isNone(membership)) return;
        const policy = yield* policies.get(membership.value.workspace.id);
        const denial = workspacePolicyDenial(policy, action);
        if (denial !== undefined) return yield* denial;
      });

      return WorkspacePolicyService.of({
        get: view,
        update: Effect.fn("WorkspacePolicyService.update")(
          function* (
            principal,
            workspaceSlug,
            input,
            expectedRevision,
            availableRunnerProfileIds,
            requestId,
          ) {
            const currentView = yield* view(principal, workspaceSlug);
            const current = currentView.policy;
            const fields = changedFields(current, input);
            if (!currentView.canUpdate) {
              return yield* rejectMutation(
                current,
                principal,
                requestId,
                fields,
                "permission",
                new SettingsScopeForbidden({ scope: "workspace" }),
              );
            }
            yield* validateUpdate(
              current,
              input,
              availableRunnerProfileIds,
            ).pipe(
              Effect.catchTag("InvalidWorkspacePolicy", (invalid) =>
                rejectMutation(
                  current,
                  principal,
                  requestId,
                  fields,
                  invalid.reason,
                  invalid,
                ),
              ),
            );
            const record = yield* auditRecord(
              current,
              principal,
              requestId,
              "success",
              fields,
            );
            const policy = yield* policies
              .put(current.workspaceId, input, expectedRevision, record)
              .pipe(
                Effect.catchTag("WorkspacePolicyConflict", (conflict) =>
                  rejectMutation(
                    current,
                    principal,
                    requestId,
                    fields,
                    "revision-conflict",
                    conflict,
                  ),
                ),
              );
            yield* audit.record({
              action: "workspace_policy.update",
              scope: "workspace",
              outcome: "success",
              requestId,
              userId: principal.userId,
              workspaceId: current.workspaceId,
            });
            return {
              ...currentView,
              policy,
            };
          },
        ),
        evaluateForUser: evaluate,
      });
    }),
  );
}
