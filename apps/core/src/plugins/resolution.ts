import type {
  PluginEnablement,
  PluginProviderId,
  PluginResolution,
  PluginToolSet,
} from "@dx/domain";
import { D1Client } from "@effect/sql-d1";
import { Layer } from "effect";
import type { Bindings } from "../http/types.js";
import { SettingsAudit } from "../settings/audit.js";
import { SettingsService } from "../settings/service.js";
import { WorkspaceRepositoryD1 } from "../settings/workspace/repository-d1.js";
import {
  decodeOwnerPolicy,
  ownerPolicyStatements,
  ownerWorkspaceIdSql,
  WorkspacePolicyRepositoryD1,
} from "../settings/workspace-policy/repository-d1.js";
import {
  WorkspacePolicyService,
  workspacePolicyDenial,
} from "../settings/workspace-policy/service.js";
import {
  type ConfigurableProviderId,
  deploymentProvider,
  installedPlugins,
  type PluginDefinition,
  providerCapabilities,
} from "./registry.js";
import {
  pluginSettingsFrom,
  pluginSettingsStatement,
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

/** Whether resolving `plugin` asks the workspace policy anything. */
const needsPolicy = (plugin: PluginDefinition) =>
  // No person can configure a provider without a credential label, so
  // policy has nothing to decide (Code). Execution resolves per Thread and
  // per project (plugins/execution/orb-providers.ts), never here, so a
  // submission pays no policy read for it.
  plugin.resolvedPerThread !== true &&
  plugin.providers.some((provider) => provider.credentialLabel !== null);

/** Whose capabilities resolve: a user, or the owner of a Thread. */
export type ResolutionSubject =
  | { readonly userId: string }
  | { readonly threadId: string };

/**
 * Everything resolution reads, in one D1 round trip: the Thread (for a
 * Thread subject), the owner's membership and workspace policy, and the
 * personal and workspace plugin settings.
 */
const readResolutionInputs = async (
  db: D1Database,
  subject: ResolutionSubject,
  plugins: ReadonlyArray<PluginDefinition>,
) => {
  const owner =
    "threadId" in subject
      ? "(SELECT owner_user_id FROM threads WHERE id = ?1)"
      : "?1";
  const key = "threadId" in subject ? subject.threadId : subject.userId;
  const [thread, membership, policy, settings] = await db.batch([
    "threadId" in subject
      ? db
          .prepare(
            "SELECT owner_user_id, lifecycle_state FROM threads WHERE id = ?1 LIMIT 1",
          )
          .bind(key)
      : db.prepare("SELECT ?1 AS owner_user_id").bind(key),
    ...ownerPolicyStatements(db, owner, [key]),
    pluginSettingsStatement(db, owner, ownerWorkspaceIdSql(owner)).bind(key),
  ]);
  if (
    thread === undefined ||
    membership === undefined ||
    policy === undefined ||
    settings === undefined
  )
    throw new Error("Plugin resolution read an incomplete batch.");
  const threadRow = thread.results[0] as
    | { readonly owner_user_id: string; readonly lifecycle_state?: string }
    | undefined;
  const workspace = await decodeOwnerPolicy(membership, policy, {
    requirePolicy: plugins.some(needsPolicy),
  });
  const allowed = new Map<string, boolean>();
  if (workspace.policy !== undefined)
    for (const plugin of plugins.filter(needsPolicy))
      allowed.set(
        plugin.id,
        workspacePolicyDenial(workspace.policy, {
          kind: "plugin.use-personal-override",
          pluginId: plugin.id,
        }) === undefined,
      );
  return {
    thread: threadRow,
    workspaceId: workspace.workspaceId as string | undefined,
    allowed,
    settings: pluginSettingsFrom(settings),
  };
};

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
): Promise<ResolvedCapabilities> =>
  resolvedFrom(
    user.userId,
    context,
    await readResolutionInputs(
      context.db,
      user,
      installedPlugins(context.bindings),
    ),
  );

/**
 * The same resolution for a Thread's owner, read in the same round trip as
 * the Thread itself. Undefined when the Thread is missing or not active.
 */
export const resolveThreadCapabilities = async (
  threadId: string,
  context: PluginResolutionContext,
): Promise<ResolvedCapabilities | undefined> => {
  const inputs = await readResolutionInputs(
    context.db,
    { threadId },
    installedPlugins(context.bindings),
  );
  if (inputs.thread === undefined || inputs.thread.lifecycle_state !== "active")
    return undefined;
  return resolvedFrom(inputs.thread.owner_user_id, context, inputs);
};

/**
 * The same resolution for a Thread's owner, whatever the Thread's lifecycle,
 * read in the same round trip as the Thread. Undefined when the Thread is
 * missing.
 */
export const resolveThreadOwnerCapabilities = async (
  threadId: string,
  context: PluginResolutionContext,
): Promise<ResolvedCapabilities | undefined> => {
  const inputs = await readResolutionInputs(
    context.db,
    { threadId },
    installedPlugins(context.bindings),
  );
  if (inputs.thread === undefined) return undefined;
  return resolvedFrom(inputs.thread.owner_user_id, context, inputs);
};

const resolvedFrom = (
  userId: string,
  context: PluginResolutionContext,
  workspace: Awaited<ReturnType<typeof readResolutionInputs>>,
): ResolvedCapabilities => {
  // Membership is always read, even with nothing installed, so workspace
  // settings keep their authorization context.
  const plugins = installedPlugins(context.bindings);
  const settings = workspace.settings;
  return {
    userId,
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
