import {
  type CommitAuthorPreference,
  type CommitSigningPreference,
  type PersistenceUnavailable,
  type PersonalAccountNotFound,
  PersonalAccountRepository,
  type PersonalProjectDefaults,
  type Principal,
  type ProjectConfiguration,
  type ProjectDefaultOverrides,
  type ProjectDefaultsConflict,
  ProjectDefaultsRepository,
  type ProjectShipAction,
  type ResolvedProjectDefaults,
  type RunnerProfileId,
  type SettingsMembershipInvariantViolation,
  SettingsScopeForbidden,
  type WorkspaceId,
  type WorkspacePolicyDenied,
  WorkspacePolicyRepository,
  type WorkspaceProjectDefaults,
  type WorkspaceProjectPolicy,
  WorkspaceRepository,
  type WorkspaceRole,
  type WorkspaceSlug,
  workspaceRoleHasPermission,
} from "@dx/domain";
import { Context, Effect, Layer, Option, Schema } from "effect";
import {
  type LoadedRunnerProfileCatalog,
  type RunnerProfileUnavailable,
  selectRunnerProfile,
} from "../../execution/runner-profiles/catalog.js";
import { SettingsAudit } from "../audit.js";
import { SettingsService } from "../service.js";
import { WorkspacePolicyService } from "../workspace-policy/service.js";

export class ProjectPolicyForbidden extends Schema.TaggedError<ProjectPolicyForbidden>()(
  "ProjectPolicyForbidden",
  {
    reason: Schema.Literals([
      "project-creation",
      "public-code",
      "runner-profile",
      "commit-signing",
    ]),
  },
) {}

export interface ProjectCreationRestrictions {
  readonly allowProjectCreation: boolean;
  readonly allowPublicCodeAccess: boolean;
  readonly allowedRunnerProfileIds: ReadonlyArray<RunnerProfileId> | null;
  readonly source: "deployment" | "workspace";
}

export interface PersonalProjectDefaultsView {
  readonly scope: "personal";
  readonly settings: PersonalProjectDefaults;
  readonly resolved: ResolvedProjectDefaults;
  readonly restrictions: ProjectCreationRestrictions;
  readonly canUpdate: true;
}

export interface WorkspaceProjectDefaultsView {
  readonly scope: "workspace";
  readonly settings: WorkspaceProjectDefaults;
  readonly resolved: ResolvedProjectDefaults;
  readonly restrictions: ProjectCreationRestrictions;
  readonly canUpdate: boolean;
  readonly workspaceRole: WorkspaceRole;
}

export interface ProjectCreationSnapshot {
  readonly workspaceId?: WorkspaceId;
  readonly configuration: ProjectConfiguration;
}

type ProjectDefaultsReadError =
  | Schema.SchemaError
  | PersistenceUnavailable
  | SettingsMembershipInvariantViolation
  | PersonalAccountNotFound
  | SettingsScopeForbidden;

type ProjectDefaultsWriteError =
  | ProjectDefaultsReadError
  | ProjectDefaultsConflict
  | RunnerProfileUnavailable
  | ProjectPolicyForbidden;

type ProjectSnapshotError =
  | ProjectDefaultsReadError
  | RunnerProfileUnavailable
  | ProjectPolicyForbidden
  | WorkspacePolicyDenied;

interface ProjectDefaultsServiceShape {
  readonly getPersonal: (
    principal: Principal,
    catalog: LoadedRunnerProfileCatalog,
  ) => Effect.Effect<PersonalProjectDefaultsView, ProjectDefaultsReadError>;
  readonly putPersonal: (
    principal: Principal,
    catalog: LoadedRunnerProfileCatalog,
    overrides: ProjectDefaultOverrides,
    expectedRevision: number,
    requestId: string,
  ) => Effect.Effect<PersonalProjectDefaultsView, ProjectDefaultsWriteError>;
  readonly getWorkspace: (
    principal: Principal,
    workspaceSlug: WorkspaceSlug,
    catalog: LoadedRunnerProfileCatalog,
  ) => Effect.Effect<WorkspaceProjectDefaultsView, ProjectDefaultsReadError>;
  readonly putWorkspace: (
    principal: Principal,
    workspaceSlug: WorkspaceSlug,
    catalog: LoadedRunnerProfileCatalog,
    overrides: ProjectDefaultOverrides,
    policy: WorkspaceProjectPolicy,
    expectedRevision: number,
    requestId: string,
  ) => Effect.Effect<WorkspaceProjectDefaultsView, ProjectDefaultsWriteError>;
  readonly snapshotForProject: (
    principal: Principal,
    catalog: LoadedRunnerProfileCatalog,
    input: {
      readonly workspaceSlug?: WorkspaceSlug;
      readonly publicCodeEnabled: boolean;
      readonly deploymentSigningAvailable: boolean;
    },
  ) => Effect.Effect<ProjectCreationSnapshot, ProjectSnapshotError>;
}

const deploymentResolved = (
  defaultProfileId: RunnerProfileId,
): ResolvedProjectDefaults => ({
  shipAction: { value: "ship", source: "deployment" },
  commitAuthor: { value: "dx", source: "deployment" },
  signingPreference: { value: "disabled", source: "deployment" },
  runnerProfileId: { value: defaultProfileId, source: "deployment" },
});

const resolveOverrides = (
  current: ResolvedProjectDefaults,
  overrides: ProjectDefaultOverrides,
  source: "personal" | "workspace",
): ResolvedProjectDefaults => ({
  shipAction:
    overrides.shipAction === null
      ? current.shipAction
      : { value: overrides.shipAction, source },
  commitAuthor:
    overrides.commitAuthor === null
      ? current.commitAuthor
      : { value: overrides.commitAuthor, source },
  signingPreference:
    overrides.signingPreference === null
      ? current.signingPreference
      : { value: overrides.signingPreference, source },
  runnerProfileId:
    overrides.runnerProfileId === null
      ? current.runnerProfileId
      : { value: overrides.runnerProfileId, source },
});

const restrictionsFor = (
  workspace:
    | {
        readonly role: WorkspaceRole;
        readonly lifecycleState: string;
        readonly policy: WorkspaceProjectPolicy;
      }
    | undefined,
): ProjectCreationRestrictions =>
  workspace === undefined
    ? {
        allowProjectCreation: true,
        allowPublicCodeAccess: true,
        allowedRunnerProfileIds: null,
        source: "deployment",
      }
    : {
        allowProjectCreation:
          workspace.lifecycleState === "active" &&
          (workspace.role !== "member" ||
            workspace.policy.allowMemberProjectCreation),
        allowPublicCodeAccess: workspace.policy.allowPublicCodeAccess,
        allowedRunnerProfileIds: workspace.policy.allowedRunnerProfileIds,
        source: "workspace",
      };

const enforceRestrictions = Effect.fn("enforceProjectRestrictions")(function* (
  catalog: LoadedRunnerProfileCatalog,
  resolved: ResolvedProjectDefaults,
  restrictions: ProjectCreationRestrictions,
  publicCodeEnabled: boolean,
  deploymentSigningAvailable: boolean,
) {
  if (!restrictions.allowProjectCreation) {
    return yield* new ProjectPolicyForbidden({ reason: "project-creation" });
  }
  if (publicCodeEnabled && !restrictions.allowPublicCodeAccess) {
    return yield* new ProjectPolicyForbidden({ reason: "public-code" });
  }
  const profile = yield* selectRunnerProfile(
    catalog,
    resolved.runnerProfileId.value,
  );
  if (
    resolved.signingPreference.value === "required" &&
    !profile.capabilities.includes("commit-signing") &&
    !deploymentSigningAvailable
  ) {
    return yield* new ProjectPolicyForbidden({ reason: "commit-signing" });
  }
  return profile;
});

export class ProjectDefaultsService extends Context.Service<
  ProjectDefaultsService,
  ProjectDefaultsServiceShape
>()("@dx/core/settings/project-defaults/ProjectDefaultsService") {
  static readonly layer = Layer.effect(
    ProjectDefaultsService,
    Effect.gen(function* () {
      const defaults = yield* ProjectDefaultsRepository;
      const accounts = yield* PersonalAccountRepository;
      const settings = yield* SettingsService;
      const workspaces = yield* WorkspaceRepository;
      const policies = yield* WorkspacePolicyRepository;
      const policyService = yield* WorkspacePolicyService;
      const audit = yield* SettingsAudit;

      const workspacePolicy = Effect.fn("workspaceProjectPolicy")(function* (
        workspaceId: WorkspaceId,
        role: WorkspaceRole,
        lifecycleState: string,
      ) {
        const workspaceDefaults = yield* defaults.getWorkspace(workspaceId);
        const workspacePolicy = yield* policies.get(workspaceId);
        const effectiveSettings = {
          ...workspaceDefaults,
          policy: {
            ...workspaceDefaults.policy,
            allowedRunnerProfileIds:
              workspacePolicy.restrictions.allowedRunnerProfileIds,
          },
        };
        return {
          settings: effectiveSettings,
          restrictions: restrictionsFor({
            role,
            lifecycleState,
            policy: effectiveSettings.policy,
          }),
        };
      });

      const getPersonal = Effect.fn("ProjectDefaultsService.getPersonal")(
        function* (principal: Principal, catalog: LoadedRunnerProfileCatalog) {
          yield* settings.personal(principal);
          const personal = yield* defaults.getPersonal(principal.userId);
          const resolved = resolveOverrides(
            deploymentResolved(catalog.configuration.defaultProfileId),
            personal.overrides,
            "personal",
          );
          const membership = yield* workspaces.findByUser(principal.userId);
          const restrictions = Option.isNone(membership)
            ? restrictionsFor(undefined)
            : (yield* workspacePolicy(
                membership.value.workspace.id,
                membership.value.role,
                membership.value.workspace.lifecycleState,
              )).restrictions;
          return {
            scope: "personal" as const,
            settings: personal,
            resolved,
            restrictions,
            canUpdate: true as const,
          };
        },
      );

      const getWorkspace = Effect.fn("ProjectDefaultsService.getWorkspace")(
        function* (
          principal: Principal,
          workspaceSlug: WorkspaceSlug,
          catalog: LoadedRunnerProfileCatalog,
        ) {
          const access = yield* settings.workspace(principal, workspaceSlug);
          const personal = yield* defaults.getPersonal(principal.userId);
          const workspace = yield* workspacePolicy(
            access.workspace.workspace.id,
            access.workspace.role,
            access.workspace.workspace.lifecycleState,
          );
          const resolved = resolveOverrides(
            resolveOverrides(
              deploymentResolved(catalog.configuration.defaultProfileId),
              personal.overrides,
              "personal",
            ),
            workspace.settings.overrides,
            "workspace",
          );
          return {
            scope: "workspace" as const,
            settings: workspace.settings,
            resolved,
            restrictions: workspace.restrictions,
            canUpdate:
              access.workspace.workspace.lifecycleState === "active" &&
              workspaceRoleHasPermission(
                access.workspace.role,
                "workspace:update",
              ),
            workspaceRole: access.workspace.role,
          };
        },
      );

      return ProjectDefaultsService.of({
        getPersonal,
        putPersonal: Effect.fn("ProjectDefaultsService.putPersonal")(
          function* (
            principal,
            catalog,
            overrides,
            expectedRevision,
            requestId,
          ) {
            const current = yield* getPersonal(principal, catalog);
            if (overrides.runnerProfileId !== null) {
              yield* selectRunnerProfile(catalog, overrides.runnerProfileId);
              if (
                current.restrictions.allowedRunnerProfileIds !== null &&
                !current.restrictions.allowedRunnerProfileIds.includes(
                  overrides.runnerProfileId,
                )
              ) {
                return yield* new ProjectPolicyForbidden({
                  reason: "runner-profile",
                });
              }
            }
            const saved = yield* defaults
              .putPersonal(principal.userId, overrides, expectedRevision)
              .pipe(
                Effect.tap(() =>
                  audit.record({
                    action: "project_defaults.personal.update",
                    scope: "personal",
                    outcome: "success",
                    requestId,
                    userId: principal.userId,
                  }),
                ),
                Effect.tapError(() =>
                  audit.record({
                    action: "project_defaults.personal.update",
                    scope: "personal",
                    outcome: "rejected",
                    requestId,
                    userId: principal.userId,
                  }),
                ),
              );
            return {
              ...current,
              settings: saved,
              resolved: resolveOverrides(
                deploymentResolved(catalog.configuration.defaultProfileId),
                saved.overrides,
                "personal",
              ),
            };
          },
        ),
        getWorkspace,
        putWorkspace: Effect.fn("ProjectDefaultsService.putWorkspace")(
          function* (
            principal,
            workspaceSlug,
            catalog,
            overrides,
            policy,
            expectedRevision,
            requestId,
          ) {
            const current = yield* getWorkspace(
              principal,
              workspaceSlug,
              catalog,
            );
            if (!current.canUpdate) {
              return yield* new SettingsScopeForbidden({ scope: "workspace" });
            }
            const effectivePolicy = {
              ...policy,
              allowedRunnerProfileIds:
                current.restrictions.allowedRunnerProfileIds,
            };
            if (overrides.runnerProfileId !== null) {
              yield* selectRunnerProfile(catalog, overrides.runnerProfileId);
              if (
                effectivePolicy.allowedRunnerProfileIds !== null &&
                !effectivePolicy.allowedRunnerProfileIds.includes(
                  overrides.runnerProfileId,
                )
              ) {
                return yield* new ProjectPolicyForbidden({
                  reason: "runner-profile",
                });
              }
            }
            const saved = yield* defaults
              .putWorkspace(
                current.settings.workspaceId,
                overrides,
                effectivePolicy,
                expectedRevision,
              )
              .pipe(
                Effect.tap(() =>
                  audit.record({
                    action: "project_defaults.workspace.update",
                    scope: "workspace",
                    outcome: "success",
                    requestId,
                    userId: principal.userId,
                    workspaceId: current.settings.workspaceId,
                    workspaceSlug,
                  }),
                ),
                Effect.tapError(() =>
                  audit.record({
                    action: "project_defaults.workspace.update",
                    scope: "workspace",
                    outcome: "rejected",
                    requestId,
                    userId: principal.userId,
                    workspaceId: current.settings.workspaceId,
                    workspaceSlug,
                  }),
                ),
              );
            const personal = yield* defaults.getPersonal(principal.userId);
            return {
              ...current,
              settings: saved,
              restrictions: restrictionsFor({
                role: current.workspaceRole,
                lifecycleState: "active",
                policy: saved.policy,
              }),
              resolved: resolveOverrides(
                resolveOverrides(
                  deploymentResolved(catalog.configuration.defaultProfileId),
                  personal.overrides,
                  "personal",
                ),
                saved.overrides,
                "workspace",
              ),
            };
          },
        ),
        snapshotForProject: Effect.fn(
          "ProjectDefaultsService.snapshotForProject",
        )(function* (principal, catalog, input) {
          let workspaceSlug = input.workspaceSlug;
          if (principal.application !== undefined) {
            const membership = yield* workspaces.findByUser(principal.userId);
            if (
              Option.isNone(membership) ||
              membership.value.workspace.id !==
                principal.application.workspaceId
            ) {
              return yield* new SettingsScopeForbidden({ scope: "workspace" });
            }
            workspaceSlug = membership.value.workspace.shortName;
          }

          let resolved: ResolvedProjectDefaults;
          let restrictions: ProjectCreationRestrictions;
          let workspaceId: WorkspaceId | undefined;
          if (workspaceSlug === undefined) {
            const personal = yield* getPersonal(principal, catalog);
            resolved = personal.resolved;
            restrictions = personal.restrictions;
          } else {
            const workspace = yield* getWorkspace(
              principal,
              workspaceSlug,
              catalog,
            );
            resolved = workspace.resolved;
            restrictions = workspace.restrictions;
            workspaceId = workspace.settings.workspaceId;
          }
          const profile = yield* enforceRestrictions(
            catalog,
            resolved,
            restrictions,
            input.publicCodeEnabled,
            input.deploymentSigningAvailable,
          );
          yield* policyService.evaluateForUser(principal.userId, {
            kind: "project.create",
            runnerProfileId: profile.id,
            runnerAdapter: profile.adapter,
          });
          const preference: CommitAuthorPreference =
            resolved.commitAuthor.value;
          const commitAuthor =
            preference === "dx"
              ? {
                  preference,
                  name: "dxcodeagent",
                  email: "agent@dxcode.dev",
                }
              : yield* accounts.findOwnedByUser(principal.userId).pipe(
                  Effect.map((account) => ({
                    preference,
                    name: account.displayName,
                    email: account.email,
                  })),
                );
          const shipAction: ProjectShipAction = resolved.shipAction.value;
          const signingPreference: CommitSigningPreference =
            resolved.signingPreference.value;
          return {
            ...(workspaceId === undefined ? {} : { workspaceId }),
            configuration: {
              shipAction,
              commitAuthor,
              signingPreference,
              runnerProfileId: resolved.runnerProfileId.value,
              publicCodeEnabled: input.publicCodeEnabled,
            },
          } satisfies ProjectCreationSnapshot;
        }),
      });
    }),
  );
}
