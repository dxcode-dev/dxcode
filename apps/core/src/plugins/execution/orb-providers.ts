import type { PluginScope, ThreadExecutionPin } from "@dx/domain";
import { Effect, Schema } from "effect";
import { orbProviderConnectors } from "../../execution/connectors.js";
import { loadRunnerProfileCatalog } from "../../execution/runner-profiles/catalog.js";
import type { Bindings } from "../../http/types.js";
import { threadProjectReachableSql } from "../../settings/members/membership-sql.js";
import { findPlugin, isLocalRuntime } from "../registry.js";
import {
  CONNECTION_COLUMNS,
  connectionFromRow,
  type OrbConnection,
  type OrbConnectionRow,
} from "./connections-d1.js";
import type { OrbProviderConnectors } from "./connector.js";
import { connectionStatus, servedVersion } from "./preparation.js";
import {
  type ExecutionProviderId,
  type ResolvedExecutionProvider,
  resolveExecutionProviders,
} from "./provider.js";

/**
 * The Orb providers a person can start a Thread on in a project's scope
 * (tasks/orb-provider-connections.md): every provider the deployment
 * offers on its own account, plus every provider the person or their
 * workspace connected. For each provider the usual precedence picks the
 * account (personal over workspace over deployment). No provider is
 * required: a person with none connects one first. The set is only for the
 * new-Thread picker and Thread creation; a Thread pins its member and never
 * resolves the set again.
 */

export interface OrbProviderMember {
  readonly providerId: ExecutionProviderId;
  readonly scope: PluginScope;
  /** The person or workspace whose account pays; null for the deployment. */
  readonly ownerId: string | null;
  /** The provider account a connection belongs to. */
  readonly account: string | null;
  readonly status: OrbConnection["status"];
  /** Size → the target its Threads pin; only for a ready connection. */
  readonly targets?: ReadonlyMap<string, string>;
  /**
   * The connection is preparing a new version; new Threads meanwhile pin
   * the last ready one.
   */
  readonly updating?: true;
}

export interface OrbProviderSetInput {
  readonly deploymentProviders: ReadonlyArray<ResolvedExecutionProvider>;
  /** Adapters that have at least one runner profile in the catalog. */
  readonly profileAdapters: ReadonlySet<string>;
  readonly personal: ReadonlyArray<OrbConnection>;
  readonly workspace: ReadonlyArray<OrbConnection>;
  /** The project's workspace; null for a personal project. */
  readonly projectWorkspaceId: string | null;
  /** That workspace's policy flags; null when it has no policy row. */
  readonly policy: {
    readonly allowPersonalPluginOverrides: boolean;
    readonly allowPersonalExecutionOverrides: boolean;
  } | null;
  readonly localRuntime: boolean;
  readonly connectors: OrbProviderConnectors;
  /** Each connector's recipe for this build. */
  readonly recipes: ReadonlyMap<ExecutionProviderId, string>;
}

/**
 * Personal connections are denied on workspace projects unless the
 * workspace explicitly opted in. `allowPersonalPluginOverrides` defaults to
 * true, so on its own it is not an opt-in: Execution also needs
 * `allowPersonalExecutionOverrides`, which defaults to false. Personal
 * projects always honor them.
 */
export const personalOrbKeysAllowed = (
  input: Pick<OrbProviderSetInput, "projectWorkspaceId" | "policy">,
) =>
  input.projectWorkspaceId === null ||
  (input.policy?.allowPersonalPluginOverrides === true &&
    input.policy.allowPersonalExecutionOverrides === true);

const connectionMember = (
  connection: OrbConnection,
  input: OrbProviderSetInput,
): OrbProviderMember => {
  const recipe = input.recipes.get(connection.providerId);
  const connector = input.connectors[connection.providerId];
  const status =
    recipe === undefined ? "preparing" : connectionStatus(connection, recipe);
  const served =
    status === "ready" || connector === undefined
      ? null
      : servedVersion(connection, connector);
  if (served !== null)
    return {
      providerId: connection.providerId,
      scope: connection.scope,
      ownerId: connection.targetId,
      account: served.account,
      status: "ready",
      targets: new Map(Object.entries(served.targets)),
      updating: true,
    };
  const targets =
    status === "ready" ? connector?.targets(connection) : undefined;
  return {
    providerId: connection.providerId,
    scope: connection.scope,
    ownerId: connection.targetId,
    account: connection.account,
    status,
    ...(targets === undefined ? {} : { targets }),
  };
};

/** The providers a person can start a Thread on, in registry order. */
export const orbProviderSet = (
  input: OrbProviderSetInput,
): ReadonlyArray<OrbProviderMember> => {
  const plugin = findPlugin("execution");
  if (plugin === undefined) return [];
  const personalAllowed = personalOrbKeysAllowed(input);
  return plugin.providers.flatMap((provider): Array<OrbProviderMember> => {
    const providerId = provider.id as ExecutionProviderId;
    if (!input.profileAdapters.has(providerId)) return [];
    const deployment = input.deploymentProviders.some(
      (candidate) => candidate.providerId === providerId,
    );
    // Local runtime ignores personal and workspace connections: `pnpm dev`
    // never reaches a provider account.
    if (input.connectors[providerId] !== undefined && !input.localRuntime) {
      const own =
        (personalAllowed
          ? input.personal.find(
              (connection) => connection.providerId === providerId,
            )
          : undefined) ??
        input.workspace.find(
          (connection) => connection.providerId === providerId,
        );
      if (own !== undefined) return [connectionMember(own, input)];
    }
    return deployment
      ? [
          {
            providerId,
            scope: "deployment",
            ownerId: null,
            account: null,
            status: "ready",
          },
        ]
      : [];
  });
};

/** Each connector's recipe for this build, by provider. */
export const orbProviderRecipes = async (
  connectors: OrbProviderConnectors,
): Promise<ReadonlyMap<ExecutionProviderId, string>> =>
  new Map(
    await Promise.all(
      Object.values(connectors).map(
        async (connector) =>
          [connector.providerId, await connector.recipe()] as const,
      ),
    ),
  );

export interface OrbScopeContext {
  /** The person's workspace, if any. */
  readonly memberWorkspaceId: string | null;
  /** The project's workspace (a projectless Thread uses the person's). */
  readonly projectWorkspaceId: string | null;
  /** The project's own runner profile, when a project was named. */
  readonly projectRunnerProfileId: string | null;
  readonly policy: OrbProviderSetInput["policy"];
  readonly personal: ReadonlyArray<OrbConnection>;
  readonly workspace: ReadonlyArray<OrbConnection>;
}

/**
 * Everything the set needs, in one D1 round trip: membership, the
 * project's workspace and policy, and the person's and workspace's
 * connections. `projectId` null means a projectless Thread.
 */
export const loadOrbScope = async (
  db: D1Database,
  userId: string,
  projectId: string | null,
): Promise<OrbScopeContext> => {
  const [scopeResult, connectionsResult] = await db.batch([
    db
      .prepare(
        `WITH scope AS (
           SELECT
             (SELECT member.organizationId FROM member
                JOIN organization ON organization.id = member.organizationId
               WHERE member.userId = ?1 AND organization.lifecycleState = 'active'
               LIMIT 1) AS member_workspace_id,
             (SELECT workspace_id FROM projects
               WHERE id = ?2
                 AND ${threadProjectReachableSql("projects", "?1")})
               AS named_workspace_id,
             (SELECT runner_profile_id FROM projects
               WHERE id = ?2
                 AND ${threadProjectReachableSql("projects", "?1")})
               AS project_runner_profile_id
         )
         SELECT scope.member_workspace_id,
                CASE WHEN ?2 IS NULL THEN scope.member_workspace_id
                     ELSE scope.named_workspace_id END AS project_workspace_id,
                scope.project_runner_profile_id,
                policy.allow_personal_plugin_overrides,
                policy.allow_personal_execution_overrides
           FROM scope
           LEFT JOIN workspace_policy AS policy
             ON policy.workspace_id = CASE WHEN ?2 IS NULL
               THEN scope.member_workspace_id ELSE scope.named_workspace_id END`,
      )
      .bind(userId, projectId),
    db
      .prepare(
        `SELECT ${CONNECTION_COLUMNS}
           FROM orb_connection
          WHERE (scope = 'personal' AND target_id = ?1)
             OR (scope = 'workspace' AND target_id =
               (SELECT organizationId FROM member WHERE userId = ?1 LIMIT 1))`,
      )
      .bind(userId),
  ]);
  const scope = (scopeResult?.results[0] ?? {}) as {
    readonly member_workspace_id?: string | null;
    readonly project_workspace_id?: string | null;
    readonly project_runner_profile_id?: string | null;
    readonly allow_personal_plugin_overrides?: number | null;
    readonly allow_personal_execution_overrides?: number | null;
  };
  const connections = (
    (connectionsResult?.results ?? []) as Array<OrbConnectionRow>
  ).map(connectionFromRow);
  return {
    memberWorkspaceId: scope.member_workspace_id ?? null,
    projectWorkspaceId: scope.project_workspace_id ?? null,
    projectRunnerProfileId: scope.project_runner_profile_id ?? null,
    policy:
      scope.allow_personal_plugin_overrides == null
        ? null
        : {
            allowPersonalPluginOverrides:
              scope.allow_personal_plugin_overrides === 1,
            allowPersonalExecutionOverrides:
              scope.allow_personal_execution_overrides === 1,
          },
    personal: connections.filter(({ scope }) => scope === "personal"),
    workspace: connections.filter(({ scope }) => scope === "workspace"),
  };
};

/**
 * A new Thread's Orb cannot start: its account's connection is still
 * preparing or failed, or no provider the person can use offers the size.
 * Never retried on another account.
 */
export class OrbUnavailable extends Schema.TaggedError<OrbUnavailable>()(
  "OrbUnavailable",
  { reason: Schema.Literals(["preparing", "failed", "no-provider"]) },
) {}

/**
 * The pin a new Thread records: resolves the provider set once, at
 * creation, for the Thread's size (the requested profile, else the
 * project's) and takes that provider's member. Undefined for the local
 * runtime's provider or a size the catalog does not know (creation rejects
 * that size elsewhere). Fails with `OrbUnavailable` when no provider the
 * person can use serves the size, or its connection is not ready.
 */
export const resolveThreadExecutionPin = async (input: {
  readonly db: D1Database;
  readonly bindings: Bindings;
  readonly userId: string;
  readonly projectId: string | null;
  readonly runnerProfileId: string | undefined;
  /** A projectless Thread's project defaults to this size. */
  readonly projectlessRunnerProfileId?: string;
  readonly connectors?: OrbProviderConnectors;
}): Promise<ThreadExecutionPin | undefined> => {
  const connectors = input.connectors ?? orbProviderConnectors;
  const catalog = await Effect.runPromise(
    loadRunnerProfileCatalog(input.bindings).pipe(
      Effect.orElseSucceed(() => undefined),
    ),
  );
  if (catalog === undefined) return undefined;
  const scope = await loadOrbScope(input.db, input.userId, input.projectId);
  const profileId =
    input.runnerProfileId ??
    (input.projectId === null
      ? input.projectlessRunnerProfileId
      : scope.projectRunnerProfileId);
  const profile = catalog.configuration.profiles.find(
    ({ id }) => id === profileId,
  );
  if (
    profile === undefined ||
    (profile.adapter !== "e2b" && profile.adapter !== "cloudflare")
  )
    return undefined;
  const deploymentProviders = resolveExecutionProviders(input.bindings);
  const localRuntime = isLocalRuntime(input.bindings);
  const deploymentPin: ThreadExecutionPin = {
    provider: profile.adapter,
    runnerProfileId: profile.id,
    credentialScope: "deployment",
    credentialOwnerId: null,
    credentialAccount: null,
    providerTemplate: null,
  };
  // `pnpm dev` keeps its local behavior: no pin unless the deployment
  // serves the size, and activation fails closed.
  if (localRuntime)
    return deploymentProviders.some(
      ({ providerId }) => providerId === profile.adapter,
    )
      ? deploymentPin
      : undefined;
  const member = orbProviderSet({
    deploymentProviders,
    profileAdapters: new Set(
      catalog.configuration.profiles.map(({ adapter }) => adapter as string),
    ),
    personal: scope.personal,
    workspace: scope.workspace,
    projectWorkspaceId: scope.projectWorkspaceId,
    policy: scope.policy,
    localRuntime,
    connectors,
    recipes: await orbProviderRecipes(connectors),
  }).find(({ providerId }) => providerId === profile.adapter);
  if (member === undefined) throw new OrbUnavailable({ reason: "no-provider" });
  if (member.status !== "ready")
    throw new OrbUnavailable({
      reason: member.status === "failed" ? "failed" : "preparing",
    });
  if (member.scope === "deployment") return deploymentPin;
  const target = member.targets?.get(profile.id);
  if (
    target === undefined ||
    member.ownerId === null ||
    member.account === null
  )
    throw new OrbUnavailable({ reason: "preparing" });
  return {
    provider: profile.adapter,
    runnerProfileId: profile.id,
    credentialScope: member.scope,
    credentialOwnerId: member.ownerId,
    credentialAccount: member.account,
    providerTemplate: target,
  };
};
