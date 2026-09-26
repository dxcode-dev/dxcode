import {
  EnvironmentVariableRepository,
  MAX_PLUGINS_PER_SCOPE,
  McpServerRepository,
  type PersistenceUnavailable,
  PluginGrantedPermissions,
  PluginId,
  type PluginImportBundle,
  type PluginIntegrity,
  PluginIntegrityConflict,
  PluginLimitExceeded,
  PluginPermissionInvalid,
  PluginRepository,
  type PluginTarget,
  type PluginVersion,
  type PluginWithVersion,
  type Principal,
  type ProjectId,
  type ResolvedPluginSnapshot,
  type SettingsMembershipInvariantViolation,
  StoredPlugin,
  StoredPluginVersion,
  type UserId,
  type WorkspaceId,
  type WorkspacePolicyDenied,
} from "@dx/domain";
import { Context, DateTime, Effect, Layer, Schema } from "effect";
import { SettingsAudit } from "../audit.js";
import { WorkspacePolicyService } from "../workspace-policy/service.js";
import { type PluginPreview, previewPluginImport } from "./import.js";

interface AuditContext {
  readonly userId: UserId;
  readonly requestId: string;
}

interface PluginStateInput {
  readonly enabled?: boolean;
  readonly activeVersion?: PluginVersion;
}

interface PluginServiceShape {
  readonly preview: (
    bundle: PluginImportBundle,
  ) => ReturnType<typeof previewPluginImport>;
  readonly list: (
    target: PluginTarget,
  ) => ReturnType<typeof PluginRepository.Service.list>;
  readonly trust: (
    target: PluginTarget,
    bundle: PluginImportBundle,
    reviewedIntegrity: PluginIntegrity,
    grants: PluginGrantedPermissions,
    audit: AuditContext,
  ) => Effect.Effect<PluginWithVersion, unknown>;
  readonly update: (
    target: PluginTarget,
    id: typeof PluginId.Type,
    bundle: PluginImportBundle,
    reviewedIntegrity: PluginIntegrity,
    grants: PluginGrantedPermissions,
    activate: boolean,
    audit: AuditContext,
  ) => Effect.Effect<PluginWithVersion, unknown>;
  readonly changeState: (
    target: PluginTarget,
    id: typeof PluginId.Type,
    input: PluginStateInput,
    audit: AuditContext,
  ) => Effect.Effect<PluginWithVersion, unknown>;
  readonly remove: (
    target: PluginTarget,
    id: typeof PluginId.Type,
    audit: AuditContext,
  ) => Effect.Effect<void, unknown>;
  readonly resolveForThread: (
    principal: Principal,
    projectId: ProjectId,
  ) => Effect.Effect<
    ReadonlyArray<ResolvedPluginSnapshot>,
    | PersistenceUnavailable
    | Schema.SchemaError
    | SettingsMembershipInvariantViolation
    | WorkspacePolicyDenied
  >;
  readonly getWorkspacePolicy: (
    workspaceId: WorkspaceId,
  ) => ReturnType<typeof PluginRepository.Service.getWorkspacePolicy>;
  readonly setWorkspacePolicy: (
    workspaceId: WorkspaceId,
    allowPersonal: boolean,
    audit: AuditContext,
  ) => Effect.Effect<void, unknown>;
}

export class PluginService extends Context.Service<
  PluginService,
  PluginServiceShape
>()("@dx/core/settings/plugins/PluginService") {
  static readonly layer = Layer.effect(
    PluginService,
    Effect.gen(function* () {
      const repository = yield* PluginRepository;
      const variables = yield* EnvironmentVariableRepository;
      const mcpServers = yield* McpServerRepository;
      const settingsAudit = yield* SettingsAudit;
      const workspacePolicies = yield* WorkspacePolicyService;

      const personalGrantsAllowed = Effect.fn(
        "PluginService.personalGrantsAllowed",
      )(function* (principal: Principal, candidate: PluginWithVersion) {
        if (candidate.plugin.target.scope === "workspace") return true;
        if (candidate.active.grants.secretReferences.length > 0) {
          const allowed = yield* workspacePolicies
            .evaluateForUser(principal.userId, {
              kind: "secret.use-personal-override",
            })
            .pipe(
              Effect.as(true),
              Effect.catchTag("WorkspacePolicyDenied", (denial) =>
                denial.reason === "personal-secret-overrides-disabled"
                  ? Effect.succeed(false)
                  : Effect.fail(denial),
              ),
            );
          if (!allowed) return false;
        }
        if (candidate.active.grants.mcpServerIds.length > 0) {
          return yield* workspacePolicies
            .evaluateForUser(principal.userId, {
              kind: "mcp.use-personal-override",
            })
            .pipe(
              Effect.as(true),
              Effect.catchTag("WorkspacePolicyDenied", (denial) =>
                denial.reason === "personal-mcp-overrides-disabled"
                  ? Effect.succeed(false)
                  : Effect.fail(denial),
              ),
            );
        }
        return true;
      });

      const audit = (
        action: string,
        target: PluginTarget,
        context: AuditContext,
        pluginId?: typeof PluginId.Type,
        pluginVersion?: string,
      ) =>
        settingsAudit.record({
          action,
          scope: target.scope,
          outcome: "success",
          requestId: context.requestId,
          userId: context.userId,
          ...(pluginId === undefined ? {} : { pluginId }),
          ...(pluginVersion === undefined ? {} : { pluginVersion }),
        });

      const invalidPermission = (permission: string) =>
        Effect.fail(new PluginPermissionInvalid({ permission }));

      const subset = (
        granted: ReadonlyArray<string>,
        requested: ReadonlyArray<string>,
        permission: string,
      ) =>
        granted.every((value) => requested.includes(value))
          ? Effect.void
          : invalidPermission(permission);

      const validateGrants = Effect.fn("PluginService.validateGrants")(
        function* (
          target: PluginTarget,
          preview: Pick<PluginPreview, "manifest">,
          unknownGrants: unknown,
        ) {
          const grants = yield* Schema.decodeUnknownEffect(
            PluginGrantedPermissions,
          )(unknownGrants, { onExcessProperty: "error" }).pipe(
            Effect.mapError(
              () => new PluginPermissionInvalid({ permission: "grants" }),
            ),
          );
          const requested = preview.manifest.permissions;
          yield* Effect.all([
            subset(grants.tools, requested.tools, "tools"),
            subset(grants.commands, requested.commands, "commands"),
            subset(grants.lifecycle, requested.lifecycle, "lifecycle"),
            subset(grants.uiSurfaces, requested.uiSurfaces, "uiSurfaces"),
            subset(
              grants.networkDestinations,
              requested.networkDestinations,
              "networkDestinations",
            ),
            subset(grants.filesystem, requested.filesystem, "filesystem"),
            subset(grants.mcpServerIds, requested.mcpServerIds, "mcpServerIds"),
            subset(
              grants.agentCapabilities,
              requested.agentCapabilities,
              "agentCapabilities",
            ),
            subset(grants.triggers, requested.triggers, "triggers"),
            subset(
              grants.secretReferences.map(({ name }) => name),
              requested.secretNames,
              "secretReferences",
            ),
          ]);
          if (target.scope === "personal") {
            if (grants.secretReferences.length > 0) {
              yield* workspacePolicies.evaluateForUser(target.id, {
                kind: "secret.use-personal-override",
              });
            }
            if (grants.mcpServerIds.length > 0) {
              yield* workspacePolicies.evaluateForUser(target.id, {
                kind: "mcp.use-personal-override",
              });
            }
          }
          yield* Effect.all(
            grants.secretReferences.map(({ name, reference }) =>
              variables.find(target, reference.id).pipe(
                Effect.flatMap((variable) =>
                  variable.kind === "secret" &&
                  variable.enabled &&
                  String(variable.name) === String(name)
                    ? Effect.void
                    : invalidPermission(`secret:${name}`),
                ),
                Effect.catch(() => invalidPermission(`secret:${name}`)),
              ),
            ),
            { concurrency: 4 },
          );
          yield* Effect.all(
            grants.mcpServerIds.map((id) =>
              mcpServers.find(target, id).pipe(
                Effect.flatMap(({ server, tools }) =>
                  server.enabled &&
                  tools.some(
                    (tool) =>
                      tool.approvedSchemaHash !== undefined &&
                      tool.approvedSchemaHash === tool.schemaHash,
                  )
                    ? Effect.void
                    : invalidPermission(`mcp:${id}`),
                ),
                Effect.catch(() => invalidPermission(`mcp:${id}`)),
              ),
            ),
            { concurrency: 4 },
          );
          return grants;
        },
      );

      const checkedPreview = Effect.fn("PluginService.checkedPreview")(
        function* (bundle: PluginImportBundle, expected: PluginIntegrity) {
          const preview = yield* previewPluginImport(bundle);
          if (preview.integrity !== expected) {
            return yield* new PluginIntegrityConflict();
          }
          return preview;
        },
      );

      const makeVersion = Effect.fn("PluginService.makeVersion")(function* (
        pluginId: typeof PluginId.Type,
        preview: PluginPreview,
        grants: PluginGrantedPermissions,
        trustedByUserId: UserId,
      ) {
        const trustedAt = yield* DateTime.now;
        return yield* Schema.decodeUnknownEffect(
          Schema.toType(StoredPluginVersion),
        )({
          pluginId,
          version: preview.manifest.version,
          manifest: preview.manifest,
          files: preview.files,
          source: preview.source,
          integrity: preview.integrity,
          grants,
          trusted: true,
          trustedAt,
          trustedByUserId,
        });
      });

      return PluginService.of({
        preview: previewPluginImport,
        list: repository.list,
        trust: Effect.fn("PluginService.trust")(
          function* (
            target,
            bundle,
            reviewedIntegrity,
            unknownGrants,
            auditContext,
          ) {
            const existing = yield* repository.list(target);
            if (existing.length >= MAX_PLUGINS_PER_SCOPE) {
              return yield* new PluginLimitExceeded();
            }
            const preview = yield* checkedPreview(bundle, reviewedIntegrity);
            const grants = yield* validateGrants(
              target,
              preview,
              unknownGrants,
            );
            const id = yield* Schema.decodeEffect(PluginId)(
              `plg_${crypto.randomUUID()}`,
            );
            const version = yield* makeVersion(
              id,
              preview,
              grants,
              auditContext.userId,
            );
            const plugin = yield* Schema.decodeUnknownEffect(
              Schema.toType(StoredPlugin),
            )({
              id,
              target,
              name: preview.manifest.name,
              enabled: false,
              activeVersion: version.version,
              healthStatus: "unchecked",
              createdAt: version.trustedAt,
              updatedAt: version.trustedAt,
            });
            yield* repository.insert(plugin, version);
            yield* audit(
              "plugin.trust",
              target,
              auditContext,
              id,
              version.version,
            );
            return yield* repository.find(target, id);
          },
        ),
        update: Effect.fn("PluginService.update")(
          function* (
            target,
            id,
            bundle,
            reviewedIntegrity,
            unknownGrants,
            activate,
            auditContext,
          ) {
            const current = yield* repository.find(target, id);
            const preview = yield* checkedPreview(bundle, reviewedIntegrity);
            if (
              preview.manifest.name !== current.plugin.name ||
              current.versions.includes(preview.manifest.version)
            ) {
              return yield* new PluginIntegrityConflict();
            }
            const grants = yield* validateGrants(
              target,
              preview,
              unknownGrants,
            );
            const version = yield* makeVersion(
              id,
              preview,
              grants,
              auditContext.userId,
            );
            yield* repository.insertVersion(
              target,
              version,
              activate,
              version.trustedAt,
            );
            yield* audit(
              activate ? "plugin.update_activate" : "plugin.update_publish",
              target,
              auditContext,
              id,
              version.version,
            );
            return yield* repository.find(target, id);
          },
        ),
        changeState: Effect.fn("PluginService.changeState")(
          function* (target, id, input, auditContext) {
            const current = yield* repository.find(target, id);
            const activeVersion =
              input.activeVersion ?? current.plugin.activeVersion;
            if (input.enabled === true || input.activeVersion !== undefined) {
              const version = yield* repository.findVersion(id, activeVersion);
              yield* validateGrants(target, version, version.grants);
            }
            const updatedAt = yield* DateTime.now;
            yield* repository.updateState(target, id, input, updatedAt);
            yield* audit(
              input.activeVersion !== undefined
                ? "plugin.rollback"
                : input.enabled === false
                  ? "plugin.disable"
                  : "plugin.enable",
              target,
              auditContext,
              id,
              activeVersion,
            );
            return yield* repository.find(target, id);
          },
        ),
        remove: Effect.fn("PluginService.remove")(
          function* (target, id, auditContext) {
            const removedAt = yield* DateTime.now;
            yield* repository.updateState(
              target,
              id,
              { enabled: false, removedAt },
              removedAt,
            );
            yield* audit("plugin.remove", target, auditContext, id);
          },
        ),
        resolveForThread: Effect.fn("PluginService.resolveForThread")(
          function* (principal, projectId) {
            const candidates = yield* repository.listEffectiveForThread(
              principal.userId,
              projectId,
            );
            const snapshots: Array<ResolvedPluginSnapshot> = [];
            for (const candidate of candidates.slice(
              0,
              MAX_PLUGINS_PER_SCOPE * 2,
            )) {
              if (!(yield* personalGrantsAllowed(principal, candidate))) {
                continue;
              }
              const { plugin, active } = candidate;
              snapshots.push({
                id: plugin.id,
                version: active.version,
                name: plugin.name,
                scope: plugin.target.scope,
                integrity: active.integrity,
              });
            }
            return snapshots;
          },
        ),
        getWorkspacePolicy: repository.getWorkspacePolicy,
        setWorkspacePolicy: Effect.fn("PluginService.setWorkspacePolicy")(
          function* (workspaceId, allowPersonal, auditContext) {
            yield* repository.setWorkspacePolicy(workspaceId, allowPersonal);
            yield* settingsAudit.record({
              action: "plugin_workspace_policy.update",
              scope: "workspace",
              outcome: "success",
              requestId: auditContext.requestId,
              userId: auditContext.userId,
              workspaceId,
            });
          },
        ),
      });
    }),
  );
}
