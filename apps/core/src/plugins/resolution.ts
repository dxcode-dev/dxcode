import {
  type PluginEnablement,
  type PluginProviderId,
  type PluginResolution,
  type PluginToolSet,
  type UserId,
  WorkspaceRepository,
} from "@dx/domain";
import { D1Client } from "@effect/sql-d1";
import { Effect, Layer, Option } from "effect";
import type { Bindings } from "../http/types.js";
import { SettingsAudit } from "../settings/audit.js";
import { SettingsService } from "../settings/service.js";
import { WorkspaceRepositoryD1 } from "../settings/workspace/repository-d1.js";
import { WorkspacePolicyRepositoryD1 } from "../settings/workspace-policy/repository-d1.js";
import { WorkspacePolicyService } from "../settings/workspace-policy/service.js";
import {
  type ConfigurableProviderId,
  deploymentProvider,
  installedPlugins,
  type PluginDefinition,
  providerCapabilities,
} from "./registry.js";
import {
  listPluginSettings,
  type StoredPluginSetting,
} from "./settings-store-d1.js";

export interface ScopeSettingView {
  readonly enablement: PluginEnablement | null;
  readonly providerId: ConfigurableProviderId | null;
}

export interface PluginResolutionInput {
  readonly plugin: PluginDefinition;
  readonly deploymentProviderId: PluginProviderId | undefined;
  /** Undefined when the user has no workspace. */
  readonly workspace: ScopeSettingView | undefined;
  readonly personal: ScopeSettingView;
  readonly personalOverridesAllowed: boolean;
}

/**
 * The resolution rules from wiki/plugin-platform-direction.md for one
 * installed plugin and one user:
 *
 * - An always-on plugin ignores enablement at every scope.
 * - A workspace `disabled` is absolute for its members.
 * - Otherwise enablement is personal, else workspace, else the deployment
 *   default (`enabled` for an installed plugin).
 * - The provider is the personal configuration when policy allows personal
 *   overrides, else workspace, else deployment.
 * - No provider (or no capability the provider claims) means no tools.
 */
export const resolvePlugin = (
  input: PluginResolutionInput,
): PluginResolution => {
  if (input.plugin.alwaysOn !== true) {
    if (input.workspace?.enablement === "disabled")
      return { status: "disabled", by: "workspace" };
    const enablement =
      input.personal.enablement ?? input.workspace?.enablement ?? "enabled";
    if (enablement === "disabled")
      return { status: "disabled", by: "personal" };
  }
  const provider =
    input.personalOverridesAllowed && input.personal.providerId !== null
      ? { providerId: input.personal.providerId, scope: "personal" as const }
      : input.workspace?.providerId != null
        ? {
            providerId: input.workspace.providerId,
            scope: "workspace" as const,
          }
        : input.deploymentProviderId !== undefined
          ? {
              providerId: input.deploymentProviderId,
              scope: "deployment" as const,
            }
          : undefined;
  if (provider === undefined) return { status: "no-provider" };
  const claimed = providerCapabilities(input.plugin, provider.providerId);
  const capabilities = input.plugin.capabilities.filter((capability) =>
    claimed.includes(capability),
  );
  if (capabilities.length === 0) return { status: "no-provider" };
  return { status: "active", provider, capabilities };
};

export interface PluginState {
  readonly plugin: PluginDefinition;
  readonly resolution: PluginResolution;
  readonly deploymentProviderId: PluginProviderId | undefined;
  readonly workspaceSetting: StoredPluginSetting | undefined;
  readonly personalSetting: StoredPluginSetting | undefined;
  readonly personalOverridesAllowed: boolean;
}

export interface ResolvedCapabilities {
  readonly userId: string;
  readonly workspaceId: string | undefined;
  readonly plugins: ReadonlyArray<PluginState>;
}

export interface PluginResolutionContext {
  readonly db: D1Database;
  readonly bindings: Bindings;
}

export const workspacePolicyLayer = (db: D1Database) => {
  const workspace = WorkspaceRepositoryD1(db).pipe(
    Layer.provide(D1Client.layer({ db })),
  );
  const settings = SettingsService.layer.pipe(Layer.provide(workspace));
  return Layer.mergeAll(
    workspace,
    settings,
    WorkspacePolicyService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          workspace,
          settings,
          WorkspacePolicyRepositoryD1(db),
          SettingsAudit.layer,
        ),
      ),
    ),
  );
};

/** Membership plus the typed policy decision for each plugin. */
const loadWorkspaceContext = (
  db: D1Database,
  userId: UserId,
  plugins: ReadonlyArray<PluginDefinition>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const membership = yield* (yield* WorkspaceRepository).findByUser(userId);
      const policy = yield* WorkspacePolicyService;
      const allowed = new Map<string, boolean>();
      for (const plugin of plugins) {
        // No person can configure a provider without a credential label, so
        // policy has nothing to decide (Code). Execution resolves per Thread
        // and per project (plugins/execution/orb-providers.ts), never here,
        // so a submission pays no policy read for it.
        if (
          plugin.resolvedPerThread === true ||
          plugin.providers.every(
            (provider) => provider.credentialLabel === null,
          )
        )
          continue;
        allowed.set(
          plugin.id,
          yield* policy
            .evaluateForUser(userId, {
              kind: "plugin.use-personal-override",
              pluginId: plugin.id,
            })
            .pipe(
              Effect.as(true),
              Effect.catchTag("WorkspacePolicyDenied", () =>
                Effect.succeed(false),
              ),
            ),
        );
      }
      return {
        workspaceId: Option.getOrUndefined(membership)?.workspace.id as
          | string
          | undefined,
        allowed,
      };
    }).pipe(Effect.provide(workspacePolicyLayer(db))),
  );

const scopeView = (setting: StoredPluginSetting | undefined) => ({
  enablement: setting?.enablement ?? null,
  providerId: setting?.configuration?.providerId ?? null,
});

/**
 * Agent-agnostic resolution of every installed first-party plugin for one
 * user. DxAgent and every future agent consume this same result.
 */
export const resolveCapabilities = async (
  user: { readonly userId: string },
  context: PluginResolutionContext,
): Promise<ResolvedCapabilities> => {
  // Always load membership, even with nothing installed, so workspace
  // settings keep their authorization context.
  const plugins = installedPlugins(context.bindings);
  const workspace = await loadWorkspaceContext(
    context.db,
    user.userId as UserId,
    plugins,
  );
  const settings = await listPluginSettings(
    context.db,
    user.userId,
    workspace.workspaceId,
  );
  return {
    userId: user.userId,
    workspaceId: workspace.workspaceId,
    plugins: plugins.map((plugin) => {
      const personalSetting = settings.find(
        (setting) =>
          setting.scope === "personal" && setting.pluginId === plugin.id,
      );
      const workspaceSetting =
        workspace.workspaceId === undefined
          ? undefined
          : settings.find(
              (setting) =>
                setting.scope === "workspace" && setting.pluginId === plugin.id,
            );
      const personalOverridesAllowed = workspace.allowed.get(plugin.id) ?? true;
      const deploymentProviderId = deploymentProvider(plugin, context.bindings);
      return {
        plugin,
        deploymentProviderId,
        workspaceSetting,
        personalSetting,
        personalOverridesAllowed,
        resolution: resolvePlugin({
          plugin,
          deploymentProviderId,
          workspace:
            workspace.workspaceId === undefined
              ? undefined
              : scopeView(workspaceSetting),
          personal: scopeView(personalSetting),
          personalOverridesAllowed,
        }),
      };
    }),
  };
};

/**
 * The plugin tools a submission mounts: active plugins and their
 * capabilities. Plugins resolved per Thread (Execution) are not part of it.
 */
export const pluginToolSet = (resolved: ResolvedCapabilities): PluginToolSet =>
  resolved.plugins.flatMap(({ plugin, resolution }) =>
    resolution.status === "active" && plugin.resolvedPerThread !== true
      ? [
          {
            pluginId: plugin.id,
            capabilities: resolution.capabilities,
          },
        ]
      : [],
  );
