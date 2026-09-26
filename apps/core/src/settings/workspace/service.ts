import {
  type CreateWorkspaceInput,
  type PersistenceUnavailable,
  type Principal,
  type SettingsMembershipInvariantViolation,
  SettingsScopeForbidden,
  type UpdateWorkspaceProfileInput,
  type WorkspaceMembership,
  WorkspaceMembershipExists,
  type WorkspaceNotFound,
  type WorkspaceProfileConflict,
  type WorkspaceProfileRevision,
  WorkspaceRepository,
  type WorkspaceShortName,
  type WorkspaceShortNameUnavailable,
  workspaceRoleHasPermission,
} from "@dx/domain";
import { Context, Effect, Layer, Option, type Schema } from "effect";
import { SettingsAudit } from "../audit.js";
import { SettingsService } from "../service.js";

type WorkspaceReadError =
  | Schema.SchemaError
  | PersistenceUnavailable
  | SettingsMembershipInvariantViolation
  | SettingsScopeForbidden;

type WorkspaceCreateError =
  | Schema.SchemaError
  | PersistenceUnavailable
  | SettingsMembershipInvariantViolation
  | SettingsScopeForbidden
  | WorkspaceMembershipExists
  | WorkspaceShortNameUnavailable;

type WorkspaceUpdateError =
  | WorkspaceReadError
  | WorkspaceNotFound
  | WorkspaceProfileConflict
  | WorkspaceShortNameUnavailable;

interface WorkspaceProfileServiceShape {
  readonly create: (
    principal: Principal,
    input: CreateWorkspaceInput,
    requestId: string,
  ) => Effect.Effect<WorkspaceMembership, WorkspaceCreateError>;
  readonly get: (
    principal: Principal,
    workspaceSlug: WorkspaceShortName,
  ) => Effect.Effect<WorkspaceMembership, WorkspaceReadError>;
  readonly update: (
    principal: Principal,
    workspaceSlug: WorkspaceShortName,
    input: UpdateWorkspaceProfileInput,
    expectedRevision: WorkspaceProfileRevision,
    requestId: string,
  ) => Effect.Effect<WorkspaceMembership, WorkspaceUpdateError>;
}

export class WorkspaceProfileService extends Context.Service<
  WorkspaceProfileService,
  WorkspaceProfileServiceShape
>()("@dx/core/settings/workspace/WorkspaceProfileService") {
  static readonly layer = Layer.effect(
    WorkspaceProfileService,
    Effect.gen(function* () {
      const settings = yield* SettingsService;
      const workspaces = yield* WorkspaceRepository;
      const audit = yield* SettingsAudit;

      return WorkspaceProfileService.of({
        create: Effect.fn("WorkspaceProfileService.create")(
          function* (principal, input, requestId) {
            if (!principal.credentialScopes?.includes("workspace")) {
              return yield* new SettingsScopeForbidden({
                scope: "workspace",
              });
            }
            const existing = yield* workspaces.findByUser(principal.userId);
            if (Option.isSome(existing)) {
              return yield* new WorkspaceMembershipExists();
            }
            return yield* workspaces
              .createOwnedByUser(principal.userId, input)
              .pipe(
                Effect.tap(() =>
                  audit.record({
                    action: "workspace.create",
                    scope: "workspace",
                    outcome: "success",
                    requestId,
                    userId: principal.userId,
                    workspaceSlug: input.shortName,
                    fields: ["displayName", "shortName"],
                  }),
                ),
                Effect.tapError(() =>
                  audit.record({
                    action: "workspace.create",
                    scope: "workspace",
                    outcome: "rejected",
                    requestId,
                    userId: principal.userId,
                    workspaceSlug: input.shortName,
                    fields: ["displayName", "shortName"],
                  }),
                ),
              );
          },
        ),
        get: Effect.fn("WorkspaceProfileService.get")(
          function* (principal, workspaceSlug) {
            return (yield* settings.workspace(principal, workspaceSlug))
              .workspace;
          },
        ),
        update: Effect.fn("WorkspaceProfileService.update")(
          function* (
            principal,
            workspaceSlug,
            input,
            expectedRevision,
            requestId,
          ) {
            const current = (yield* settings.workspace(
              principal,
              workspaceSlug,
            )).workspace;
            if (
              !workspaceRoleHasPermission(current.role, "workspace:update") ||
              current.workspace.lifecycleState !== "active"
            ) {
              return yield* new SettingsScopeForbidden({
                scope: "workspace",
              });
            }
            const fields = [
              ...(current.workspace.displayName === input.displayName
                ? []
                : (["displayName"] as const)),
              ...(current.workspace.shortName === input.shortName
                ? []
                : (["shortName"] as const)),
            ];
            const profile = yield* workspaces
              .updateProfile(current.workspace.id, input, expectedRevision)
              .pipe(
                Effect.tap(() =>
                  audit.record({
                    action: "workspace.update",
                    scope: "workspace",
                    outcome: "success",
                    requestId,
                    userId: principal.userId,
                    workspaceSlug,
                    fields,
                  }),
                ),
                Effect.tapError(() =>
                  audit.record({
                    action: "workspace.update",
                    scope: "workspace",
                    outcome: "rejected",
                    requestId,
                    userId: principal.userId,
                    workspaceSlug,
                    fields,
                  }),
                ),
              );
            return { ...current, workspace: profile };
          },
        ),
      });
    }),
  );
}
