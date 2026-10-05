import {
  type OrbProviderData,
  OrbProviderErrorResponseSchema,
  type OrbProviderKeyData,
  type OrbProviderListData,
  OrbProviderListQuerySchema,
  OrbProviderListResponseSchema,
  OrbProviderParamsSchema,
  SetOrbProviderKeyRequestSchema,
  SetOrbProviderPolicyRequestSchema,
  WorkspaceOrbProviderParamsSchema,
} from "@dx/api";
import {
  type Principal,
  SettingsScopeForbidden,
  type WorkspaceSlug,
  workspaceRoleHasPermission,
} from "@dx/domain";
import { Effect, Option, Result, Schema } from "effect";
import { type Context, Hono } from "hono";
import {
  advanceTeamTemplates,
  currentOrbTemplateRecipe,
  E2BKeyRejected,
  type E2BTeamApi,
  liveE2BTeamApi,
  startTeamTemplates,
  type TeamTemplateState,
} from "../../execution/e2b/team-templates.js";
import { loadRunnerProfileCatalog } from "../../execution/runner-profiles/catalog.js";
import type { AppEnv, Bindings } from "../../http/types.js";
import { orbProvidersLogger, settingsAuditLogger } from "../../logging.js";
import { decodeD1Binding } from "../../persistence/d1-binding.js";
import { loadConfigEncryptionKeyring } from "../../settings/config-encryption.js";
import { SettingsService } from "../../settings/service.js";
import { WorkspacePolicyService } from "../../settings/workspace-policy/service.js";
import { findPlugin, isLocalRuntime } from "../registry.js";
import { workspacePolicyLayer } from "../resolution.js";
import {
  decryptPluginCredential,
  deletePluginConfigurationStatement,
  encryptPluginCredential,
  findPluginSetting,
  pluginConfigurationStatement,
  type StoredSettingScope,
} from "../settings-store-d1.js";
import {
  claimOrbTemplate,
  deleteOrbTemplate,
  loadOrbScope,
  type OrbKeyConfiguration,
  type OrbScopeContext,
  orbProviderSet,
  orbTemplateStatus,
  putOrbTemplate,
} from "./orb-providers.js";
import {
  type ExecutionProviderId,
  resolveExecutionProviders,
} from "./provider.js";

type ErrorCode = (typeof OrbProviderErrorResponseSchema.Type)["data"]["code"];

class OrbProviderFailure extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status: 400 | 403 | 503,
  ) {
    super(code);
  }
}

const messages: Record<ErrorCode, string> = {
  INVALID_ORB_PROVIDER_REQUEST: "Orb provider request is invalid.",
  ORB_PROVIDER_KEY_REJECTED: "The provider rejected this key.",
  ORB_PROVIDER_SETTINGS_FORBIDDEN:
    "This Orb provider settings action is not permitted.",
  ORB_PROVIDER_SETTINGS_UNAVAILABLE:
    "Orb provider settings are temporarily unavailable.",
};

interface ScopeTarget {
  readonly scope: StoredSettingScope;
  readonly targetId: string;
  readonly canUpdate: boolean;
  readonly workspaceSlug?: WorkspaceSlug;
}

/** How long one template advance owns a record; also the polling floor. */
const ADVANCE_INTERVAL_MS = 10_000;

const currentRecipe = currentOrbTemplateRecipe;

const runEffect = async <A, E>(effect: Effect.Effect<A, E>): Promise<A> => {
  const result = await Effect.runPromise(Effect.result(effect));
  if (Result.isSuccess(result)) return result.success;
  if (result.failure instanceof SettingsScopeForbidden)
    throw new OrbProviderFailure("ORB_PROVIDER_SETTINGS_FORBIDDEN", 403);
  throw new OrbProviderFailure("ORB_PROVIDER_SETTINGS_UNAVAILABLE", 503);
};

const database = (c: Context<AppEnv>) => runEffect(decodeD1Binding(c.env.DB));

const personalTarget = (c: Context<AppEnv>): ScopeTarget => ({
  scope: "personal",
  targetId: c.get("principal").userId,
  canUpdate: true,
});

const workspaceTarget = async (
  c: Context<AppEnv>,
  db: D1Database,
): Promise<ScopeTarget> => {
  const params = Schema.decodeUnknownOption(WorkspaceOrbProviderParamsSchema)({
    workspaceSlug: c.req.param("workspaceSlug"),
  });
  if (Option.isNone(params))
    throw new OrbProviderFailure("INVALID_ORB_PROVIDER_REQUEST", 400);
  const access = await runEffect(
    Effect.gen(function* () {
      const settings = yield* SettingsService;
      return yield* settings.workspace(
        c.get("principal"),
        params.value.workspaceSlug,
      );
    }).pipe(Effect.provide(workspacePolicyLayer(db))),
  );
  return {
    scope: "workspace",
    targetId: access.workspace.workspace.id,
    workspaceSlug: params.value.workspaceSlug,
    canUpdate:
      access.workspace.workspace.lifecycleState === "active" &&
      workspaceRoleHasPermission(access.workspace.role, "workspace:update"),
  };
};

/** Adapters with at least one runner profile: a provider needs sizes. */
const profileAdapters = async (bindings: Bindings) =>
  new Set(
    (
      await runEffect(loadRunnerProfileCatalog(bindings))
    ).configuration.profiles.map(({ adapter }) => adapter as string),
  );

const loadScope = async (
  db: D1Database,
  userId: string,
  projectId: string | null,
  target: ScopeTarget,
) => {
  const scope = await loadOrbScope(db, userId, projectId).catch(() => {
    throw new OrbProviderFailure("ORB_PROVIDER_SETTINGS_UNAVAILABLE", 503);
  });
  // Users belong to at most one workspace; a workspace view must be theirs.
  if (
    target.scope === "workspace" &&
    scope.memberWorkspaceId !== target.targetId
  )
    throw new OrbProviderFailure("ORB_PROVIDER_SETTINGS_FORBIDDEN", 403);
  return scope;
};

const decryptKey = async (
  bindings: Bindings,
  db: D1Database,
  key: Pick<OrbKeyConfiguration, "scope" | "targetId">,
) => {
  const setting = await findPluginSetting(
    db,
    key.scope,
    key.targetId,
    "execution",
  );
  if (setting?.configuration == null) return undefined;
  const keyring = await Effect.runPromise(
    loadConfigEncryptionKeyring(bindings),
  );
  return decryptPluginCredential(keyring, {
    ...setting,
    configuration: setting.configuration,
  });
};

/**
 * Moves each key's template build one step, at most once per interval per
 * key across isolates (a revision claim), so the page and picker polling
 * drive a build that takes minutes without a background job.
 */
const advanceKeys = async (
  bindings: Bindings,
  db: D1Database,
  keys: ReadonlyArray<OrbKeyConfiguration>,
  teamApi: E2BTeamApi,
) => {
  const current = await currentRecipe();
  let advanced = false;
  for (const key of keys) {
    const template = key.template;
    if (template === null || orbTemplateStatus(key, current) !== "building")
      continue;
    const now = new Date();
    const claimed = await claimOrbTemplate(
      db,
      key,
      template,
      now.toISOString(),
      new Date(now.getTime() - ADVANCE_INTERVAL_MS).toISOString(),
    );
    if (!claimed) continue;
    advanced = true;
    let next: TeamTemplateState;
    try {
      const apiKey = await decryptKey(bindings, db, key);
      if (apiKey === undefined) continue;
      next =
        template.recipe === current &&
        template.configuredAt === key.configuredAt
          ? await advanceTeamTemplates(teamApi, apiKey, current, template)
          : await startTeamTemplates(teamApi, apiKey, current);
    } catch (cause) {
      if (!(cause instanceof E2BKeyRejected)) {
        orbProvidersLogger.warn("Orb template build step failed.", {
          event: "orb_template_advance_failed",
          scope: key.scope,
          provider: key.providerId,
        });
        continue;
      }
      next = {
        state: "failed",
        account: template.account,
        builds: template.builds,
        error: "E2B rejected this key.",
      };
    }
    await putOrbTemplate(
      db,
      key,
      {
        configuredAt: key.configuredAt,
        recipe: current,
        ...next,
        // The key's account never changes within one configuration.
        account: next.account ?? template.account,
      },
      new Date().toISOString(),
      template.revision + 1,
    ).run();
    orbProvidersLogger.info("Orb template build advanced.", {
      event: "orb_template_advanced",
      scope: key.scope,
      provider: key.providerId,
      state: next.state,
      builds: next.builds.length,
    });
  }
  return advanced;
};

const keyData = (
  key: OrbKeyConfiguration | undefined,
  recipeVersion: string,
  localRuntime: boolean,
): OrbProviderKeyData | null =>
  key === undefined
    ? null
    : {
        configuredAt: key.configuredAt,
        account: key.template?.account ?? null,
        template: localRuntime
          ? null
          : {
              status: orbTemplateStatus(key, recipeVersion),
              error:
                orbTemplateStatus(key, recipeVersion) === "failed"
                  ? (key.template?.error ?? null)
                  : null,
            },
      };

const listData = async (
  bindings: Bindings,
  target: ScopeTarget,
  scope: OrbScopeContext,
): Promise<OrbProviderListData> => {
  const plugin = findPlugin("execution");
  const localRuntime = isLocalRuntime(bindings);
  const adapters = await profileAdapters(bindings);
  const deploymentProviders = resolveExecutionProviders(bindings);
  const recipeVersion = await currentRecipe();
  const own = target.scope === "personal" ? scope.personal : scope.workspace;
  const providers: Array<OrbProviderData> = (plugin?.providers ?? []).flatMap(
    (provider) => {
      const id = provider.id as ExecutionProviderId;
      const deployment = deploymentProviders.some(
        ({ providerId }) => providerId === id,
      );
      const keyed = provider.credentialLabel !== null;
      // A provider is listed when it can run a Thread here: the deployment
      // provides it, or a key could (its sizes are in the catalog). The
      // local runtime lists key-based providers so keys can be managed,
      // though it ignores them.
      if (!deployment && !(keyed && (localRuntime || adapters.has(id))))
        return [];
      return [
        {
          id,
          displayName: provider.displayName,
          credentialLabel: provider.credentialLabel,
          pauseResume: provider.capabilities.includes("execution.pause-resume")
            ? (provider.pauseResumePreserves ?? null)
            : null,
          deployment,
          key: keyData(
            own.find(({ providerId }) => providerId === id),
            recipeVersion,
            localRuntime,
          ),
          workspaceKey:
            target.scope === "personal"
              ? keyData(
                  scope.workspace.find(({ providerId }) => providerId === id),
                  recipeVersion,
                  localRuntime,
                )
              : null,
        },
      ];
    },
  );
  const resolved = orbProviderSet({
    deploymentProviders,
    profileAdapters: adapters,
    personal: scope.personal,
    workspace: scope.workspace,
    projectWorkspaceId: scope.projectWorkspaceId,
    policy: scope.policy,
    localRuntime,
    recipe: recipeVersion,
  });
  return {
    scope: target.scope,
    canUpdate: target.canUpdate,
    localRuntime,
    providers,
    personalKeysOnWorkspaceProjects:
      scope.memberWorkspaceId === null
        ? null
        : {
            allowed:
              scope.policy?.allowPersonalPluginOverrides === true &&
              scope.policy.allowPersonalExecutionOverrides,
            pluginOverridesAllowed:
              scope.policy?.allowPersonalPluginOverrides ?? true,
            executionOverridesAllowed:
              scope.policy?.allowPersonalExecutionOverrides ?? false,
          },
    resolved: resolved.map((member) => ({
      providerId: member.providerId,
      scope: member.scope,
      account: member.account,
      status: member.status,
    })),
  };
};

const audit = (
  c: Context<AppEnv>,
  target: ScopeTarget,
  action: string,
  outcome: "success" | "rejected",
) =>
  settingsAuditLogger.info("Settings mutation audited.", {
    event: "settings_mutation_audited",
    action,
    scope: target.scope,
    outcome,
    requestId: c.get("requestId"),
    userId: c.get("principal").userId,
    pluginId: "execution",
    ...(target.scope === "workspace" ? { workspaceId: target.targetId } : {}),
  });

const respond = (c: Context<AppEnv>, run: () => Promise<OrbProviderListData>) =>
  run().then(
    (data) =>
      c.json(
        Schema.encodeUnknownSync(OrbProviderListResponseSchema)({
          status: "success",
          data,
        }),
        200,
      ),
    (error: unknown) => {
      const failure =
        error instanceof OrbProviderFailure
          ? error
          : new OrbProviderFailure("ORB_PROVIDER_SETTINGS_UNAVAILABLE", 503);
      if (!(error instanceof OrbProviderFailure))
        orbProvidersLogger.error("Orb provider settings request failed.", {
          event: "orb_provider_settings_failed",
          requestId: c.get("requestId"),
          error: error instanceof Error ? error.name : "unknown",
        });
      return c.json(
        Schema.encodeUnknownSync(OrbProviderErrorResponseSchema)({
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

const decodeBody = async <S extends Schema.Top>(
  c: Context<AppEnv>,
  schema: S & { readonly DecodingServices: never },
): Promise<S["Type"]> => {
  try {
    return Schema.decodeUnknownSync(schema)(await c.req.json());
  } catch {
    throw new OrbProviderFailure("INVALID_ORB_PROVIDER_REQUEST", 400);
  }
};

const keyedProvider = async (c: Context<AppEnv>) => {
  const params = Schema.decodeUnknownOption(OrbProviderParamsSchema)({
    providerId: c.req.param("providerId"),
  });
  const plugin = findPlugin("execution");
  const provider =
    Option.isNone(params) || plugin === undefined
      ? undefined
      : plugin.providers.find(({ id }) => id === params.value.providerId);
  // Only key-based providers take a key, and only where the catalog has
  // their sizes (the local runtime keeps the key but ignores it).
  if (
    provider === undefined ||
    provider.credentialLabel === null ||
    (!isLocalRuntime(c.env) && !(await profileAdapters(c.env)).has(provider.id))
  )
    throw new OrbProviderFailure("INVALID_ORB_PROVIDER_REQUEST", 400);
  return provider.id as ExecutionProviderId;
};

export interface OrbProviderRouteOptions {
  readonly teamApi?: E2BTeamApi;
}

const mount = (
  router: Hono<AppEnv>,
  resolveTarget: (c: Context<AppEnv>, db: D1Database) => Promise<ScopeTarget>,
  options: OrbProviderRouteOptions,
) => {
  const teamApi = options.teamApi ?? liveE2BTeamApi;

  router.get("/", (c) =>
    respond(c, async () => {
      const query = Schema.decodeUnknownOption(OrbProviderListQuerySchema)({
        ...(c.req.query("projectId") === undefined
          ? {}
          : { projectId: c.req.query("projectId") }),
      });
      if (Option.isNone(query))
        throw new OrbProviderFailure("INVALID_ORB_PROVIDER_REQUEST", 400);
      const db = await database(c);
      const target = await resolveTarget(c, db);
      const userId = c.get("principal").userId;
      const projectId = query.value.projectId ?? null;
      let scope = await loadScope(db, userId, projectId, target);
      if (
        !isLocalRuntime(c.env) &&
        (await advanceKeys(
          c.env,
          db,
          target.scope === "personal"
            ? [...scope.personal, ...scope.workspace]
            : scope.workspace,
          teamApi,
        ))
      )
        scope = await loadScope(db, userId, projectId, target);
      return listData(c.env, target, scope);
    }),
  );

  router.put("/:providerId/key", (c) =>
    respond(c, async () => {
      const body = await decodeBody(c, SetOrbProviderKeyRequestSchema);
      const db = await database(c);
      const target = await resolveTarget(c, db);
      const providerId = await keyedProvider(c);
      const userId = c.get("principal").userId;
      await loadScope(db, userId, null, target);
      if (!target.canUpdate) {
        audit(c, target, "orb-provider.key.set", "rejected");
        throw new OrbProviderFailure("ORB_PROVIDER_SETTINGS_FORBIDDEN", 403);
      }
      const now = new Date().toISOString();
      const key = {
        scope: target.scope,
        targetId: target.targetId,
        providerId,
      } as const;
      const localRuntime = isLocalRuntime(c.env);
      // The local runtime keeps the key but never reaches the provider.
      let template: TeamTemplateState | undefined;
      const recipeVersion = await currentRecipe();
      if (!localRuntime)
        try {
          template = await startTeamTemplates(
            teamApi,
            body.credential,
            recipeVersion,
          );
        } catch (cause) {
          if (cause instanceof E2BKeyRejected) {
            audit(c, target, "orb-provider.key.set", "rejected");
            throw new OrbProviderFailure("ORB_PROVIDER_KEY_REJECTED", 400);
          }
          orbProvidersLogger.warn("Orb template verification failed.", {
            event: "orb_template_start_failed",
            scope: target.scope,
            provider: providerId,
          });
          throw new OrbProviderFailure(
            "ORB_PROVIDER_SETTINGS_UNAVAILABLE",
            503,
          );
        }
      const keyring = await runEffect(loadConfigEncryptionKeyring(c.env));
      const envelope = await encryptPluginCredential(
        keyring,
        {
          scope: target.scope,
          targetId: target.targetId,
          pluginId: "execution",
        },
        providerId,
        body.credential,
      );
      await db.batch([
        pluginConfigurationStatement(
          db,
          target.scope,
          target.targetId,
          "execution",
          { providerId, configuredAt: now, envelope },
        ),
        template === undefined
          ? deleteOrbTemplate(db, key)
          : putOrbTemplate(
              db,
              key,
              { configuredAt: now, recipe: recipeVersion, ...template },
              now,
            ),
      ]);
      audit(c, target, "orb-provider.key.set", "success");
      return listData(c.env, target, await loadScope(db, userId, null, target));
    }),
  );

  router.delete("/:providerId/key", (c) =>
    respond(c, async () => {
      const db = await database(c);
      const target = await resolveTarget(c, db);
      const providerId = await keyedProvider(c);
      const userId = c.get("principal").userId;
      await loadScope(db, userId, null, target);
      if (!target.canUpdate) {
        audit(c, target, "orb-provider.key.delete", "rejected");
        throw new OrbProviderFailure("ORB_PROVIDER_SETTINGS_FORBIDDEN", 403);
      }
      // Threads pinned to this key fail closed from their next operation;
      // the templates stay in the owner's own account.
      await db.batch([
        deletePluginConfigurationStatement(
          db,
          target.scope,
          target.targetId,
          "execution",
          new Date().toISOString(),
        ),
        deleteOrbTemplate(db, {
          scope: target.scope,
          targetId: target.targetId,
          providerId,
        }),
      ]);
      audit(c, target, "orb-provider.key.delete", "success");
      return listData(c.env, target, await loadScope(db, userId, null, target));
    }),
  );
};

export const makePersonalOrbProviderRoutes = (
  options: OrbProviderRouteOptions = {},
) => {
  const router = new Hono<AppEnv>();
  mount(router, async (c) => personalTarget(c), options);
  return router;
};

export const makeWorkspaceOrbProviderRoutes = (
  options: OrbProviderRouteOptions = {},
) => {
  const router = new Hono<AppEnv>();
  /**
   * The workspace's explicit opt-in for members' own Orb keys on workspace
   * projects, written through WorkspacePolicyService so revision, audit,
   * and permission checks stay in one owner. It applies together with the
   * general plugin flag.
   */
  router.put("/policy", (c) =>
    respond(c, async () => {
      const body = await decodeBody(c, SetOrbProviderPolicyRequestSchema);
      const db = await database(c);
      const target = await workspaceTarget(c, db);
      const principal: Principal = c.get("principal");
      const slug = target.workspaceSlug as WorkspaceSlug;
      await runEffect(
        Effect.gen(function* () {
          const policies = yield* WorkspacePolicyService;
          const current = yield* policies.get(principal, slug);
          if (
            current.canUpdate &&
            current.policy.restrictions.allowPersonalExecutionOverrides ===
              body.allowPersonalKeysOnWorkspaceProjects
          )
            return;
          yield* policies.update(
            principal,
            slug,
            {
              restrictions: {
                ...current.policy.restrictions,
                allowPersonalExecutionOverrides:
                  body.allowPersonalKeysOnWorkspaceProjects,
              },
            },
            current.policy.revision,
            [],
            c.get("requestId"),
          );
        }).pipe(Effect.provide(workspacePolicyLayer(db))),
      );
      return listData(
        c.env,
        target,
        await loadScope(db, principal.userId, null, target),
      );
    }),
  );
  mount(router, workspaceTarget, options);
  return router;
};

export const personalOrbProviderRoutes = makePersonalOrbProviderRoutes();
export const workspaceOrbProviderRoutes = makeWorkspaceOrbProviderRoutes();
