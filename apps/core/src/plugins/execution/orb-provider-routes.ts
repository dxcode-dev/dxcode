import {
  type OrbProviderConnectionData,
  type OrbProviderData,
  OrbProviderErrorResponseSchema,
  type OrbProviderListData,
  OrbProviderListQuerySchema,
  OrbProviderListResponseSchema,
  OrbProviderParamsSchema,
  SetOrbProviderConnectionRequestSchema,
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
import { orbProviderConnectors } from "../../execution/connectors.js";
import { loadRunnerProfileCatalog } from "../../execution/runner-profiles/catalog.js";
import type { AppEnv, Bindings } from "../../http/types.js";
import { orbProvidersLogger, settingsAuditLogger } from "../../logging.js";
import { decodeD1Binding } from "../../persistence/d1-binding.js";
import {
  type ConfigEncryptionKeyring,
  loadConfigEncryptionKeyring,
} from "../../settings/config-encryption.js";
import { SettingsService } from "../../settings/service.js";
import { WorkspacePolicyService } from "../../settings/workspace-policy/service.js";
import { findPlugin, isLocalRuntime } from "../registry.js";
import { workspacePolicyLayer } from "../resolution.js";
import {
  decryptOrbCredentials,
  deleteConnectionStatement,
  encryptOrbCredentials,
  findConnection,
  type OrbConnection,
  type OrbConnectionKey,
  putConnectionStatement,
} from "./connections-d1.js";
import {
  type OrbPreparation,
  type OrbProviderConnector,
  type OrbProviderConnectors,
  OrbProviderCredentialsRejected,
} from "./connector.js";
import {
  loadOrbScope,
  type OrbScopeContext,
  orbProviderRecipes,
  orbProviderSet,
} from "./orb-providers.js";
import {
  connectionStatus,
  PREPARATION_STALL_MS,
  schedulePreparation,
  servedVersion,
} from "./preparation.js";
import {
  type ExecutionProviderId,
  resolveExecutionProviders,
} from "./provider.js";

type ErrorCode = (typeof OrbProviderErrorResponseSchema.Type)["data"]["code"];

class OrbProviderFailure extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status: 400 | 403 | 503,
    readonly detail?: string,
  ) {
    super(code);
  }
}

const messages: Record<ErrorCode, string> = {
  INVALID_ORB_PROVIDER_REQUEST: "Orb provider request is invalid.",
  ORB_PROVIDER_CREDENTIALS_REJECTED: "The provider rejected these credentials.",
  ORB_PROVIDER_SETTINGS_FORBIDDEN:
    "This Orb provider settings action is not permitted.",
  ORB_PROVIDER_SETTINGS_UNAVAILABLE:
    "Orb provider settings are temporarily unavailable.",
};

interface ScopeTarget {
  readonly scope: OrbConnectionKey["scope"];
  readonly targetId: string;
  readonly canUpdate: boolean;
  readonly workspaceSlug?: WorkspaceSlug;
}

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

const loadCatalog = (bindings: Bindings) =>
  runEffect(loadRunnerProfileCatalog(bindings));

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

const connectionData = (
  connection: OrbConnection | undefined,
  recipes: ReadonlyMap<ExecutionProviderId, string>,
  connectors: OrbProviderConnectors,
  localRuntime: boolean,
): OrbProviderConnectionData | null => {
  if (connection === undefined) return null;
  const recipe = recipes.get(connection.providerId);
  const connector = connectors[connection.providerId];
  const status =
    localRuntime || recipe === undefined
      ? null
      : connectionStatus(connection, recipe);
  return {
    configuredAt: connection.configuredAt,
    account: connection.account,
    status,
    updating:
      status !== null &&
      status !== "ready" &&
      connector !== undefined &&
      servedVersion(connection, connector) !== null,
    progress:
      status === "preparing" && connection.recipe === recipe
        ? connection.progress
        : null,
    error: status === "failed" ? connection.error : null,
  };
};

const listData = async (
  bindings: Bindings,
  target: ScopeTarget,
  scope: OrbScopeContext,
  connectors: OrbProviderConnectors,
): Promise<OrbProviderListData> => {
  const plugin = findPlugin("execution");
  const localRuntime = isLocalRuntime(bindings);
  const catalog = await loadCatalog(bindings);
  const profiles = catalog.configuration.profiles;
  const adapters = new Set<string>(profiles.map(({ adapter }) => adapter));
  const deploymentProviders = resolveExecutionProviders(bindings);
  const recipes = await orbProviderRecipes(connectors);
  const own = target.scope === "personal" ? scope.personal : scope.workspace;
  const providers: Array<OrbProviderData> = (plugin?.providers ?? []).flatMap(
    (provider) => {
      const id = provider.id as ExecutionProviderId;
      const deployment = deploymentProviders.some(
        ({ providerId }) => providerId === id,
      );
      const connector = connectors[id];
      // A provider is listed when it can run a Thread here: the deployment
      // provides it, or a connection could (its sizes are in the catalog).
      // The local runtime lists connectable providers so connections can be
      // managed, though it ignores them.
      if (
        !deployment &&
        !(connector !== undefined && (localRuntime || adapters.has(id)))
      )
        return [];
      return [
        {
          id,
          displayName: provider.displayName,
          description:
            connector?.description ??
            "Runs Orbs on this deployment's own account.",
          fields: connector?.fields ?? [],
          sizes: profiles
            .filter(({ adapter }) => adapter === id)
            .map(({ id: sizeId, label, resources }) => ({
              id: sizeId,
              label,
              resources,
            })),
          pauseResume: provider.capabilities.includes("execution.pause-resume")
            ? (provider.pauseResumePreserves ?? null)
            : null,
          deployment,
          connection: connectionData(
            own.find(({ providerId }) => providerId === id),
            recipes,
            connectors,
            localRuntime,
          ),
          workspaceConnection:
            target.scope === "personal"
              ? connectionData(
                  scope.workspace.find(({ providerId }) => providerId === id),
                  recipes,
                  connectors,
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
    connectors,
    recipes,
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

/**
 * Preparation runs in its own object; a read only restarts one that has
 * not stepped for a while (or whose recipe changed), so a lost alarm never
 * leaves a connection preparing forever.
 */
const resumeStalledPreparations = async (
  bindings: Bindings,
  scope: OrbScopeContext,
  recipes: ReadonlyMap<ExecutionProviderId, string>,
) => {
  const stalledBefore = Date.now() - PREPARATION_STALL_MS;
  await Promise.all(
    [...scope.personal, ...scope.workspace].flatMap((connection) => {
      const recipe = recipes.get(connection.providerId);
      if (recipe === undefined) return [];
      const stalled =
        connection.recipe !== recipe ||
        (connection.status === "preparing" &&
          Date.parse(connection.updatedAt) < stalledBefore);
      return stalled
        ? [
            schedulePreparation(bindings, connection).catch(() => {
              orbProvidersLogger.warn("Orb preparation could not resume.", {
                event: "orb_preparation_resume_failed",
                provider: connection.providerId,
              });
            }),
          ]
        : [];
    }),
  );
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
            ...(failure.detail === undefined ? {} : { detail: failure.detail }),
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

/**
 * The connectable provider a request names. Only a provider with a
 * connector takes credentials, and only where the catalog has its sizes
 * (the local runtime keeps the connection but ignores it).
 */
const connectableProvider = async (
  c: Context<AppEnv>,
  connectors: OrbProviderConnectors,
): Promise<OrbProviderConnector> => {
  const params = Schema.decodeUnknownOption(OrbProviderParamsSchema)({
    providerId: c.req.param("providerId"),
  });
  const connector = Option.isNone(params)
    ? undefined
    : connectors[params.value.providerId];
  if (
    connector === undefined ||
    (!isLocalRuntime(c.env) &&
      !(await loadCatalog(c.env)).configuration.profiles.some(
        ({ adapter }) => adapter === connector.providerId,
      ))
  )
    throw new OrbProviderFailure("INVALID_ORB_PROVIDER_REQUEST", 400);
  return connector;
};

/**
 * The connector's generated credentials: the ones this connection already
 * has, else new ones.
 */
const generatedCredentials = async (
  keyring: ConfigEncryptionKeyring,
  found: Awaited<ReturnType<typeof findConnection>>,
  connector: OrbProviderConnector,
): Promise<Record<string, string>> => {
  const generators = Object.entries(connector.generatedFields ?? {});
  if (generators.length === 0) return {};
  const current =
    found === undefined
      ? {}
      : await decryptOrbCredentials(keyring, found.stored).catch(() => ({}));
  return Object.fromEntries(
    generators.map(([id, generate]) => [
      id,
      (current as Record<string, string | undefined>)[id] ?? generate(),
    ]),
  );
};

/** Saved in the local runtime, which never reaches the provider. */
const unpreparedConnection: OrbPreparation = {
  status: "preparing",
  account: null,
  state: {},
  progress: null,
  error: null,
};

export interface OrbProviderRouteOptions {
  readonly connectors?: OrbProviderConnectors;
}

const mount = (
  router: Hono<AppEnv>,
  resolveTarget: (c: Context<AppEnv>, db: D1Database) => Promise<ScopeTarget>,
  options: OrbProviderRouteOptions,
) => {
  const connectors = options.connectors ?? orbProviderConnectors;

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
      const scope = await loadScope(
        db,
        userId,
        query.value.projectId ?? null,
        target,
      );
      await resumeStalledPreparations(
        c.env,
        scope,
        await orbProviderRecipes(connectors),
      );
      return listData(c.env, target, scope, connectors);
    }),
  );

  /**
   * Saves a connection: the provider verifies the credentials in this
   * request, then the connection's object prepares the account.
   */
  router.put("/:providerId/connection", (c) =>
    respond(c, async () => {
      const body = await decodeBody(c, SetOrbProviderConnectionRequestSchema);
      const db = await database(c);
      const target = await resolveTarget(c, db);
      const connector = await connectableProvider(c, connectors);
      const userId = c.get("principal").userId;
      await loadScope(db, userId, null, target);
      if (!target.canUpdate) {
        audit(c, target, "orb-provider.connection.set", "rejected");
        throw new OrbProviderFailure("ORB_PROVIDER_SETTINGS_FORBIDDEN", 403);
      }
      // Exactly the provider's fields, each one filled in.
      const fieldIds = connector.fields.map(({ id }) => id);
      const submitted = Object.keys(body.credentials);
      if (
        submitted.length !== fieldIds.length ||
        !fieldIds.every((id) => submitted.includes(id))
      )
        throw new OrbProviderFailure("INVALID_ORB_PROVIDER_REQUEST", 400);
      const key: OrbConnectionKey = {
        scope: target.scope,
        targetId: target.targetId,
        providerId: connector.providerId,
      };
      const keyring = await runEffect(loadConfigEncryptionKeyring(c.env));
      const existing = await findConnection(db, key);
      const credentials = {
        ...body.credentials,
        ...(await generatedCredentials(keyring, existing, connector)),
      };
      const localRuntime = isLocalRuntime(c.env);
      let preparation = unpreparedConnection;
      const recipe = localRuntime ? null : await connector.recipe();
      if (recipe !== null)
        try {
          preparation = await connector.start(credentials, recipe);
        } catch (cause) {
          if (cause instanceof OrbProviderCredentialsRejected) {
            audit(c, target, "orb-provider.connection.set", "rejected");
            throw new OrbProviderFailure(
              "ORB_PROVIDER_CREDENTIALS_REJECTED",
              400,
              cause.detail,
            );
          }
          orbProvidersLogger.warn("Orb provider verification failed.", {
            event: "orb_connection_start_failed",
            scope: target.scope,
            provider: connector.providerId,
            error:
              cause instanceof Error ? cause.message.slice(0, 200) : "unknown",
          });
          throw new OrbProviderFailure(
            "ORB_PROVIDER_SETTINGS_UNAVAILABLE",
            503,
          );
        }
      // New credentials for the same account keep the version new Threads
      // use until these are ready (a token rotation stops nothing).
      const served =
        existing === undefined ||
        preparation.status === "ready" ||
        existing.connection.account === null ||
        existing.connection.account !== preparation.account
          ? null
          : servedVersion(existing.connection, connector);
      const envelope = await encryptOrbCredentials(keyring, key, credentials);
      await putConnectionStatement(db, key, {
        envelope,
        configuredAt: new Date().toISOString(),
        recipe,
        preparation,
        served,
      }).run();
      if (preparation.status === "preparing")
        await schedulePreparation(c.env, key);
      audit(c, target, "orb-provider.connection.set", "success");
      return listData(
        c.env,
        target,
        await loadScope(db, userId, null, target),
        connectors,
      );
    }),
  );

  /** Prepares a failed connection again with the credentials it has. */
  router.post("/:providerId/connection/retry", (c) =>
    respond(c, async () => {
      const db = await database(c);
      const target = await resolveTarget(c, db);
      const connector = await connectableProvider(c, connectors);
      const userId = c.get("principal").userId;
      await loadScope(db, userId, null, target);
      if (!target.canUpdate) {
        audit(c, target, "orb-provider.connection.retry", "rejected");
        throw new OrbProviderFailure("ORB_PROVIDER_SETTINGS_FORBIDDEN", 403);
      }
      const key: OrbConnectionKey = {
        scope: target.scope,
        targetId: target.targetId,
        providerId: connector.providerId,
      };
      // No recipe means the next step starts preparation over.
      const restarted = await db
        .prepare(
          `UPDATE orb_connection SET
             recipe = NULL, status = 'preparing', progress_json = NULL,
             error = NULL, revision = revision + 1, updated_at = ?
           WHERE scope = ? AND target_id = ? AND provider_id = ?
             AND status = 'failed'`,
        )
        .bind(new Date().toISOString(), key.scope, key.targetId, key.providerId)
        .run();
      if (restarted.meta.changes === 1) await schedulePreparation(c.env, key);
      audit(c, target, "orb-provider.connection.retry", "success");
      return listData(
        c.env,
        target,
        await loadScope(db, userId, null, target),
        connectors,
      );
    }),
  );

  router.delete("/:providerId/connection", (c) =>
    respond(c, async () => {
      const db = await database(c);
      const target = await resolveTarget(c, db);
      const connector = await connectableProvider(c, connectors);
      const userId = c.get("principal").userId;
      await loadScope(db, userId, null, target);
      if (!target.canUpdate) {
        audit(c, target, "orb-provider.connection.delete", "rejected");
        throw new OrbProviderFailure("ORB_PROVIDER_SETTINGS_FORBIDDEN", 403);
      }
      // Threads pinned to this connection fail closed from their next
      // operation; what preparation made stays in the owner's account.
      await deleteConnectionStatement(db, {
        scope: target.scope,
        targetId: target.targetId,
        providerId: connector.providerId,
      }).run();
      audit(c, target, "orb-provider.connection.delete", "success");
      return listData(
        c.env,
        target,
        await loadScope(db, userId, null, target),
        connectors,
      );
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
  const connectors = options.connectors ?? orbProviderConnectors;
  /**
   * The workspace's explicit opt-in for members' own Orb connections on
   * workspace projects, written through WorkspacePolicyService so revision,
   * audit, and permission checks stay in one owner. It applies together
   * with the general plugin flag.
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
        connectors,
      );
    }),
  );
  mount(router, workspaceTarget, options);
  return router;
};

export const personalOrbProviderRoutes = makePersonalOrbProviderRoutes();
export const workspaceOrbProviderRoutes = makeWorkspaceOrbProviderRoutes();
