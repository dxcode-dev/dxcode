import {
  FirstPartyPluginErrorResponseSchema,
  type FirstPartyPluginListData,
  FirstPartyPluginListResponseSchema,
  FirstPartyPluginParamsSchema,
  SetFirstPartyPluginConfigurationRequestSchema,
  SetFirstPartyPluginEnablementRequestSchema,
  SetFirstPartyPluginPolicyRequestSchema,
  WorkspaceFirstPartyPluginParamsSchema,
} from "@dx/api";
import {
  type Principal,
  SettingsScopeForbidden,
  type WorkspaceSlug,
  workspaceRoleHasPermission,
} from "@dx/domain";
import { Effect, Option, Result, Schema } from "effect";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../http/types.js";
import { settingsAuditLogger } from "../logging.js";
import { decodeD1Binding } from "../persistence/d1-binding.js";
import { loadConfigEncryptionKeyring } from "../settings/config-encryption.js";
import { SettingsService } from "../settings/service.js";
import { WorkspacePolicyService } from "../settings/workspace-policy/service.js";
import { findProvider } from "./registry.js";
import {
  type PluginState,
  type ResolvedCapabilities,
  resolveCapabilities,
  resolvePlugin,
  workspacePolicyLayer,
} from "./resolution.js";
import {
  deletePluginConfiguration,
  encryptPluginCredential,
  putPluginConfiguration,
  putPluginEnablement,
  type StoredSettingScope,
} from "./settings-store-d1.js";

type ErrorCode =
  (typeof FirstPartyPluginErrorResponseSchema.Type)["data"]["code"];

class PluginSettingsFailure extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status: 400 | 403 | 404 | 503,
  ) {
    super(code);
  }
}

const messages: Record<ErrorCode, string> = {
  INVALID_PLUGIN_REQUEST: "Plugin settings request is invalid.",
  PLUGIN_NOT_INSTALLED: "This plugin is not installed on this deployment.",
  PLUGIN_SETTINGS_FORBIDDEN: "This plugin settings action is not permitted.",
  PLUGIN_PERSONAL_OVERRIDE_DENIED:
    "Your workspace decides this plugin's configuration.",
  PLUGIN_SETTINGS_UNAVAILABLE: "Plugin settings are temporarily unavailable.",
};

interface ScopeTarget {
  readonly scope: StoredSettingScope;
  readonly targetId: string;
  readonly canUpdate: boolean;
  readonly workspaceSlug?: WorkspaceSlug;
}

const scopeView = (state: PluginState, scope: StoredSettingScope) =>
  scope === "personal" ? state.personalSetting : state.workspaceSetting;

const listData = (
  resolved: ResolvedCapabilities,
  target: ScopeTarget,
): FirstPartyPluginListData => ({
  scope: target.scope,
  canUpdate: target.canUpdate,
  plugins: resolved.plugins.map((state) => {
    const own = scopeView(state, target.scope);
    const workspace = state.workspaceSetting;
    return {
      id: state.plugin.id,
      displayName: state.plugin.displayName,
      description: state.plugin.description,
      capabilities: state.plugin.capabilities,
      alwaysOn: state.plugin.alwaysOn === true,
      providers: state.plugin.providers.map((provider) => ({
        id: provider.id,
        displayName: provider.displayName,
        capabilities: provider.capabilities,
        credentialLabel: provider.credentialLabel,
      })),
      enablement: own?.enablement ?? null,
      configuration:
        own?.configuration == null
          ? null
          : {
              providerId: own.configuration.providerId,
              configuredAt: own.configuration.configuredAt,
            },
      inherited: {
        workspace:
          target.scope === "personal" && resolved.workspaceId !== undefined
            ? {
                enablement: workspace?.enablement ?? null,
                providerId: workspace?.configuration?.providerId ?? null,
              }
            : null,
        deployment: { providerId: state.deploymentProviderId ?? null },
      },
      effective:
        target.scope === "personal"
          ? state.resolution
          : resolvePlugin({
              plugin: state.plugin,
              deploymentProviderId: state.deploymentProviderId,
              workspace: {
                enablement: workspace?.enablement ?? null,
                providerId: workspace?.configuration?.providerId ?? null,
              },
              personal: { enablement: null, providerId: null },
              personalOverridesAllowed: state.personalOverridesAllowed,
            }),
      personalOverridesAllowed: state.personalOverridesAllowed,
    };
  }),
});

const runEffect = async <A, E>(effect: Effect.Effect<A, E>): Promise<A> => {
  const result = await Effect.runPromise(Effect.result(effect));
  if (Result.isSuccess(result)) return result.success;
  if (result.failure instanceof SettingsScopeForbidden)
    throw new PluginSettingsFailure("PLUGIN_SETTINGS_FORBIDDEN", 403);
  throw new PluginSettingsFailure("PLUGIN_SETTINGS_UNAVAILABLE", 503);
};

const database = (c: Context<AppEnv>) => runEffect(decodeD1Binding(c.env.DB));

const workspaceTarget = async (
  c: Context<AppEnv>,
  db: D1Database,
): Promise<ScopeTarget> => {
  const params = Schema.decodeUnknownOption(
    WorkspaceFirstPartyPluginParamsSchema,
  )({ workspaceSlug: c.req.param("workspaceSlug") });
  if (Option.isNone(params))
    throw new PluginSettingsFailure("INVALID_PLUGIN_REQUEST", 400);
  const access = await runEffect(
    Effect.gen(function* () {
      const settings = yield* SettingsService;
      return yield* settings.workspace(
        c.get("principal"),
        params.value.workspaceSlug,
      );
    }).pipe(Effect.provide(workspacePolicyLayer(db))),
  );
  const workspace = access.workspace;
  return {
    scope: "workspace",
    targetId: workspace.workspace.id,
    workspaceSlug: params.value.workspaceSlug,
    canUpdate:
      workspace.workspace.lifecycleState === "active" &&
      workspaceRoleHasPermission(workspace.role, "workspace:update"),
  };
};

const personalTarget = (c: Context<AppEnv>): ScopeTarget => ({
  scope: "personal",
  targetId: c.get("principal").userId,
  canUpdate: true,
});

const resolveFor = async (
  c: Context<AppEnv>,
  db: D1Database,
  target: ScopeTarget,
) => {
  const resolved = await resolveCapabilities(
    { userId: c.get("principal").userId },
    { db, bindings: c.env },
  ).catch(() => {
    throw new PluginSettingsFailure("PLUGIN_SETTINGS_UNAVAILABLE", 503);
  });
  // Users belong to at most one workspace; a workspace view must be theirs.
  if (target.scope === "workspace" && resolved.workspaceId !== target.targetId)
    throw new PluginSettingsFailure("PLUGIN_SETTINGS_FORBIDDEN", 403);
  return resolved;
};

const decodeBody = async <S extends Schema.Top>(
  c: Context<AppEnv>,
  schema: S & { readonly DecodingServices: never },
): Promise<S["Type"]> => {
  try {
    return Schema.decodeUnknownSync(schema)(await c.req.json());
  } catch {
    throw new PluginSettingsFailure("INVALID_PLUGIN_REQUEST", 400);
  }
};

const installedPlugin = (
  resolved: ResolvedCapabilities,
  c: Context<AppEnv>,
) => {
  const params = Schema.decodeUnknownOption(FirstPartyPluginParamsSchema)({
    pluginId: c.req.param("pluginId"),
  });
  const state = Option.isNone(params)
    ? undefined
    : resolved.plugins.find(
        ({ plugin }) => plugin.id === params.value.pluginId,
      );
  if (state === undefined)
    throw new PluginSettingsFailure("PLUGIN_NOT_INSTALLED", 404);
  return state;
};

const audit = (
  c: Context<AppEnv>,
  target: ScopeTarget,
  action: string,
  outcome: "success" | "rejected",
  pluginId?: string,
) =>
  settingsAuditLogger.info("Settings mutation audited.", {
    event: "settings_mutation_audited",
    action,
    scope: target.scope,
    outcome,
    requestId: c.get("requestId"),
    userId: c.get("principal").userId,
    ...(target.scope === "workspace" ? { workspaceId: target.targetId } : {}),
    ...(pluginId === undefined ? {} : { pluginId }),
  });

const respond = (
  c: Context<AppEnv>,
  run: () => Promise<FirstPartyPluginListData>,
) =>
  run().then(
    (data) =>
      c.json(
        Schema.encodeUnknownSync(FirstPartyPluginListResponseSchema)({
          status: "success",
          data,
        }),
        200,
      ),
    (error: unknown) => {
      const failure =
        error instanceof PluginSettingsFailure
          ? error
          : new PluginSettingsFailure("PLUGIN_SETTINGS_UNAVAILABLE", 503);
      return c.json(
        Schema.encodeUnknownSync(FirstPartyPluginErrorResponseSchema)({
          status: "error",
          data: {
            code: failure.code,
            message: messages[failure.code],
            requestId: c.get("requestId"),
          },
        } as never),
        failure.status,
      );
    },
  );

const mutation = async (
  c: Context<AppEnv>,
  resolveTarget: (c: Context<AppEnv>, db: D1Database) => Promise<ScopeTarget>,
  action: string,
  apply: (
    db: D1Database,
    target: ScopeTarget,
    state: PluginState,
    now: string,
  ) => Promise<void>,
) => {
  const db = await database(c);
  const target = await resolveTarget(c, db);
  const before = await resolveFor(c, db, target);
  const state = installedPlugin(before, c);
  if (!target.canUpdate) {
    audit(c, target, action, "rejected", state.plugin.id);
    throw new PluginSettingsFailure("PLUGIN_SETTINGS_FORBIDDEN", 403);
  }
  await apply(db, target, state, new Date().toISOString());
  audit(c, target, action, "success", state.plugin.id);
  return listData(await resolveFor(c, db, target), target);
};

const mount = (
  router: Hono<AppEnv>,
  resolveTarget: (c: Context<AppEnv>, db: D1Database) => Promise<ScopeTarget>,
) => {
  router.get("/", (c) =>
    respond(c, async () => {
      const db = await database(c);
      const target = await resolveTarget(c, db);
      return listData(await resolveFor(c, db, target), target);
    }),
  );

  router.put("/:pluginId/enablement", (c) =>
    respond(c, async () => {
      const body = await decodeBody(
        c,
        SetFirstPartyPluginEnablementRequestSchema,
      );
      return mutation(
        c,
        resolveTarget,
        "plugin.enablement.set",
        (db, target, state, now) => {
          if (state.plugin.alwaysOn === true)
            throw new PluginSettingsFailure("INVALID_PLUGIN_REQUEST", 400);
          return putPluginEnablement(
            db,
            target.scope,
            target.targetId,
            state.plugin.id,
            body.enablement,
            now,
          ).then(() => undefined);
        },
      );
    }),
  );

  router.put("/:pluginId/configuration", (c) =>
    respond(c, async () => {
      const body = await decodeBody(
        c,
        SetFirstPartyPluginConfigurationRequestSchema,
      );
      return mutation(
        c,
        resolveTarget,
        "plugin.configuration.set",
        async (db, target, state, now) => {
          const provider = findProvider(state.plugin, body.providerId);
          // Orb keys are managed by the Orb Providers routes, which build
          // the provider's template into the key's own account.
          if (
            state.plugin.resolvedPerThread === true ||
            provider === undefined ||
            provider.credentialLabel === null
          )
            throw new PluginSettingsFailure("INVALID_PLUGIN_REQUEST", 400);
          if (target.scope === "personal" && !state.personalOverridesAllowed) {
            audit(c, target, "plugin.configuration.set", "rejected");
            throw new PluginSettingsFailure(
              "PLUGIN_PERSONAL_OVERRIDE_DENIED",
              403,
            );
          }
          const keyring = await runEffect(loadConfigEncryptionKeyring(c.env));
          const setting = {
            scope: target.scope,
            targetId: target.targetId,
            pluginId: state.plugin.id,
          };
          await putPluginConfiguration(
            db,
            target.scope,
            target.targetId,
            state.plugin.id,
            {
              providerId: body.providerId,
              configuredAt: now,
              envelope: await encryptPluginCredential(
                keyring,
                setting,
                body.providerId,
                body.credential,
              ),
            },
          );
        },
      );
    }),
  );

  router.delete("/:pluginId/configuration", (c) =>
    respond(c, () =>
      mutation(
        c,
        resolveTarget,
        "plugin.configuration.delete",
        (db, target, state, now) =>
          deletePluginConfiguration(
            db,
            target.scope,
            target.targetId,
            state.plugin.id,
            now,
          ).then(() => undefined),
      ),
    ),
  );
};

export const personalFirstPartyPluginRoutes = new Hono<AppEnv>();
mount(personalFirstPartyPluginRoutes, async (c) => personalTarget(c));

export const workspaceFirstPartyPluginRoutes = new Hono<AppEnv>();

/**
 * Workspace policy decides whether members' personal plugin configurations
 * apply. This writes the typed restriction through WorkspacePolicyService so
 * revision, audit, and permission checks stay in one owner.
 */
workspaceFirstPartyPluginRoutes.put("/policy", (c) =>
  respond(c, async () => {
    const body = await decodeBody(c, SetFirstPartyPluginPolicyRequestSchema);
    const db = await database(c);
    const target = await workspaceTarget(c, db);
    const principal: Principal = c.get("principal");
    const slug = target.workspaceSlug as WorkspaceSlug;
    await runEffect(
      Effect.gen(function* () {
        const policies = yield* WorkspacePolicyService;
        const current = yield* policies.get(principal, slug);
        // Skip a no-op write only for callers who may update; anyone else
        // goes through update, which rejects with 403 and audits the attempt.
        if (
          current.canUpdate &&
          current.policy.restrictions.allowPersonalPluginOverrides ===
            body.allowPersonalOverrides
        )
          return;
        yield* policies.update(
          principal,
          slug,
          {
            restrictions: {
              ...current.policy.restrictions,
              allowPersonalPluginOverrides: body.allowPersonalOverrides,
            },
          },
          current.policy.revision,
          [],
          c.get("requestId"),
        );
      }).pipe(Effect.provide(workspacePolicyLayer(db))),
    );
    return listData(await resolveFor(c, db, target), target);
  }),
);
mount(workspaceFirstPartyPluginRoutes, workspaceTarget);
