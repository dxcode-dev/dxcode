import {
  type PersistenceUnavailable,
  type Principal,
  type SettingsMembershipInvariantViolation,
  SettingsScopeForbidden,
  type SettingsWorkspaceMembership,
  type WorkspaceSlug,
  WorkspaceRepository,
} from "@dx/domain";
import { Context, Effect, Layer, Option, type Schema } from "effect";

export interface PersonalSettingsAccessContext {
  readonly activeScope: "personal";
  readonly workspace?: SettingsWorkspaceMembership;
}

export interface WorkspaceSettingsAccessContext {
  readonly activeScope: "workspace";
  readonly workspace: SettingsWorkspaceMembership;
}

export type SettingsAccessContext =
  | PersonalSettingsAccessContext
  | WorkspaceSettingsAccessContext;

type SettingsAccessError =
  | Schema.SchemaError
  | PersistenceUnavailable
  | SettingsMembershipInvariantViolation;

interface SettingsServiceShape {
  readonly personal: (
    principal: Principal,
  ) => Effect.Effect<
    PersonalSettingsAccessContext,
    SettingsAccessError | SettingsScopeForbidden
  >;
  readonly workspace: (
    principal: Principal,
    workspaceSlug: WorkspaceSlug,
  ) => Effect.Effect<
    WorkspaceSettingsAccessContext,
    SettingsAccessError | SettingsScopeForbidden
  >;
}

export class SettingsService extends Context.Service<
  SettingsService,
  SettingsServiceShape
>()("@dx/core/settings/SettingsService") {
  static readonly layer = Layer.effect(
    SettingsService,
    Effect.gen(function* () {
      const workspaces = yield* WorkspaceRepository;

      return SettingsService.of({
        personal: Effect.fn("SettingsService.personal")(function* (principal) {
          if (!principal.credentialScopes?.includes("personal")) {
            return yield* new SettingsScopeForbidden({ scope: "personal" });
          }
          if (!principal.credentialScopes.includes("workspace")) {
            return { activeScope: "personal" as const };
          }
          const workspace = yield* workspaces.findByUser(principal.userId);
          return {
            activeScope: "personal" as const,
            workspace: Option.getOrUndefined(workspace),
          };
        }),
        workspace: Effect.fn("SettingsService.workspace")(
          function* (principal, workspaceSlug) {
            if (!principal.credentialScopes?.includes("workspace")) {
              return yield* new SettingsScopeForbidden({
                scope: "workspace",
              });
            }
            const workspace = yield* workspaces.findByUser(principal.userId);
            if (
              Option.isNone(workspace) ||
              workspace.value.workspace.shortName !== workspaceSlug
            ) {
              return yield* new SettingsScopeForbidden({ scope: "workspace" });
            }
            return {
              activeScope: "workspace" as const,
              workspace: workspace.value,
            };
          },
        ),
      });
    }),
  );
}
