import {
  orbProviderBetaFeature,
  type PluginScope,
  type ThreadExecutionPin,
} from "@dx/domain";
import { Effect, Schema } from "effect";
import {
  accountDeploymentProviders,
  type DeploymentOrbs,
  deploymentOrbsFor,
  deploymentSizeAccount,
  namedSizeDeploymentProviders,
  presentedDeploymentProviders,
} from "../../execution/deployment-orbs.js";
import { loadRunnerProfileCatalog } from "../../execution/runner-profiles/catalog.js";
import type { Bindings } from "../../http/types.js";
import { defaultMachine, ownsMachine } from "../../runners/repository.js";
import { threadProjectReachableSql } from "../../settings/members/membership-sql.js";
import { findPlugin, isLocalRuntime } from "../registry.js";
import {
  CONNECTION_COLUMNS,
  connectionFromRow,
  findConnection,
  type OrbConnection,
  type OrbConnectionRow,
} from "./connections-d1.js";
import type { OrbProviderConnectors } from "./connector.js";
import {
  deploymentPrepared,
  deploymentTargets,
  scheduleDeploymentPreparation,
} from "./deployment-preparation.js";
import {
  connectionStatus,
  PREPARATION_STALL_MS,
  restartPreparation,
  schedulePreparation,
  servedVersion,
} from "./preparation.js";
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
   * Sizes the connection's account cannot run, with the provider's reason;
   * only for a ready connection. A size with no target is unavailable even
   * when its connector names no reason.
   */
  readonly unavailable?: ReadonlyMap<string, string>;
  /**
   * The connection is preparing a new version; new Threads meanwhile pin
   * the last ready one.
   */
  readonly updating?: true;
  /**
   * The deployment's account of a provider it runs only under its own
   * named sizes (`DeploymentOrbSettings.sizes`): it serves those sizes and
   * no other, beside any person's or workspace's own key for the provider.
   */
  readonly namedSizes?: true;
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
  /**
   * Beta providers the person has not turned on (`hiddenOrbProviders`):
   * offered on no connection, and on the deployment's account only when the
   * deployment presents it under its own name (`presentedDeployment`).
   */
  readonly hiddenProviders?: ReadonlySet<string>;
  /**
   * Deployment accounts closed to the person (a deployment's own offer
   * before it launches, `registeredClosedOrbProviders`): neither listed nor
   * started, even when presented under the deployment's name.
   */
  readonly closedProviders?: ReadonlySet<string>;
  /** Providers whose deployment account is presented as the deployment's own Orb. */
  readonly presentedDeployment?: ReadonlySet<string>;
  /**
   * Providers whose deployment account runs only the deployment's named
   * sizes (`namedSizeDeploymentProviders`).
   */
  readonly namedSizeProviders?: ReadonlySet<string>;
  /**
   * Providers with a named size on one of the admin's deployment accounts
   * (`accountDeploymentProviders`): offered on the deployment's account
   * though no secret or binding installs them.
   */
  readonly accountProviders?: ReadonlySet<string>;
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

export const connectionMember = (
  connection: OrbConnection,
  input: Pick<OrbProviderSetInput, "recipes" | "connectors">,
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
      unavailable: new Map(Object.entries(served.unavailable ?? {})),
      updating: true,
    };
  const targets =
    status === "ready" ? connector?.targets(connection) : undefined;
  const unavailable =
    targets === undefined ? undefined : connector?.unavailable?.(connection);
  return {
    providerId: connection.providerId,
    scope: connection.scope,
    ownerId: connection.targetId,
    account: connection.account,
    status,
    ...(targets === undefined ? {} : { targets }),
    ...(unavailable === undefined ? {} : { unavailable }),
  };
};

const NO_REASON = "This account cannot run this size.";

/**
 * The sizes among `sizeIds` that a ready member's account cannot run, each
 * with the provider's reason. A deployment provider runs every size.
 */
export const unavailableSizes = <Id extends string>(
  member: Pick<OrbProviderMember, "targets" | "unavailable">,
  sizeIds: ReadonlyArray<Id>,
): ReadonlyArray<{ readonly id: Id; readonly reason: string }> => {
  const targets = member.targets;
  if (targets === undefined) return [];
  return sizeIds.flatMap((id) =>
    targets.has(id)
      ? []
      : [{ id, reason: member.unavailable?.get(id) ?? NO_REASON }],
  );
};

const deploymentMember = (
  providerId: ExecutionProviderId,
  namedSizes: boolean,
): OrbProviderMember => ({
  providerId,
  scope: "deployment",
  ownerId: null,
  account: null,
  status: "ready",
  ...(namedSizes ? { namedSizes: true as const } : {}),
});

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
    // The deployment can offer two accounts of one provider: its own
    // secret or binding with the provider's sizes (plain), and its named
    // sizes (a hosted offer's), on that secret (`namedSizeProviders`) or on
    // accounts its admin added (`accountProviders`). A closed offer hides
    // the named sizes. A person's or workspace's own key for the provider
    // is offered either way.
    const closed = input.closedProviders?.has(providerId) === true;
    const envNamed = input.namedSizeProviders?.has(providerId) === true;
    const accountNamed = input.accountProviders?.has(providerId) === true;
    const hidden = input.hiddenProviders?.has(providerId) === true;
    const installed = input.deploymentProviders.some(
      (candidate) => candidate.providerId === providerId,
    );
    // A beta provider the person hasn't turned on is still offered on the
    // deployment's account when the deployment presents it as its own.
    const presented = input.presentedDeployment?.has(providerId) === true;
    const namedOffered =
      !closed &&
      ((installed && envNamed) || accountNamed) &&
      (!hidden || presented);
    // A closed offer closes the plain account only when the deployment
    // presents that account as its own; one whose named sizes run on admin
    // accounts presents them, not it.
    const plainOffered =
      installed &&
      !envNamed &&
      (!hidden || presented) &&
      !(closed && presented && !accountNamed);
    const named = namedOffered ? [deploymentMember(providerId, true)] : [];
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
      // A hidden beta provider's own key is not offered, and its Threads
      // never fall back to the deployment's account: that would bill
      // someone else's account for a Thread meant for their own.
      if (own !== undefined) {
        if (hidden) return [];
        // The deployment's named sizes stay offered beside the person's
        // own key: they are a different choice, on a different account.
        return [connectionMember(own, input), ...named];
      }
    }
    return [
      ...(plainOffered ? [deploymentMember(providerId, false)] : []),
      ...named,
    ];
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
  {
    reason: Schema.Literals([
      "preparing",
      "failed",
      "no-provider",
      "size-unavailable",
      "beta-provider-off",
      "no-runner",
    ]),
    /** The size's provider, for `beta-provider-off`. */
    provider: Schema.optional(Schema.String),
  },
) {}

/** What a person does about `beta-provider-off`: turn the provider's flag on. */
export const betaProviderOffDetail = (providerId: string | undefined) => {
  const name =
    (providerId === undefined
      ? undefined
      : findPlugin("execution")?.providers.find(({ id }) => id === providerId)
          ?.displayName) ?? "This provider";
  return `${name} Orbs are in beta. Turn on ${name} Orbs in Settings → Experimental Features to start Threads on it, or choose another Orb.`;
};

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
  /**
   * A runner Thread's machine (`rn.machine`); the person's most recently
   * seen machine when absent.
   */
  readonly runnerMachineId?: string;
  /** A projectless Thread's project defaults to this size. */
  readonly projectlessRunnerProfileId?: string;
  /** The providers people and workspaces can connect (execution/orb-providers). */
  readonly connectors: OrbProviderConnectors;
  /**
   * Beta providers the person has not turned on; no Thread pins them. Read
   * only when the Thread's size is on a beta provider, so other Threads
   * spend no D1 call on it.
   */
  readonly hiddenProviders?: () => Promise<ReadonlySet<string>>;
  /**
   * The deployment accounts closed to the person (`registeredClosedOrbProviders`);
   * a Thread on one is refused as if the deployment had no such provider.
   */
  readonly closedProviders?: () => Promise<ReadonlySet<string>>;
  /** How the deployment presents its own accounts; defaults to how it does now. */
  readonly deploymentOrbs?: DeploymentOrbs;
}): Promise<ThreadExecutionPin | undefined> => {
  const connectors = input.connectors;
  const scope = await loadOrbScope(input.db, input.userId, input.projectId);
  const profileId =
    input.runnerProfileId ??
    (input.projectId === null
      ? input.projectlessRunnerProfileId
      : scope.projectRunnerProfileId);
  // Only a named size reads which of the admin's accounts runs it.
  const deploymentOrbs =
    input.deploymentOrbs ??
    (await deploymentOrbsFor(input.bindings, profileId ?? undefined));
  const catalog = await Effect.runPromise(
    loadRunnerProfileCatalog(input.bindings, deploymentOrbs).pipe(
      Effect.orElseSucceed(() => undefined),
    ),
  );
  if (catalog === undefined) return undefined;
  const profile = catalog.configuration.profiles.find(
    ({ id }) => id === profileId,
  );
  if (profile === undefined || profile.adapter === "local") return undefined;
  const deploymentProviders = resolveExecutionProviders(input.bindings);
  const localRuntime = isLocalRuntime(input.bindings);
  const hiddenProviders =
    input.hiddenProviders === undefined ||
    orbProviderBetaFeature(profile.adapter) === undefined
      ? undefined
      : await input.hiddenProviders();
  // A named size pins the provider size it runs as, so a Thread keeps its
  // Orb whatever the deployment later names its sizes after.
  const providerSize = profile.runsAs ?? profile.id;
  const deploymentPin: ThreadExecutionPin = {
    provider: profile.adapter,
    runnerProfileId: providerSize,
    credentialScope: "deployment",
    credentialOwnerId: null,
    credentialAccount: null,
    providerTemplate: null,
  };
  // A runner Thread pins the person's own machine, not an account, in
  // `pnpm dev` and deployments alike.
  if (profile.adapter === "runner") {
    if (!deploymentProviders.some(({ providerId }) => providerId === "runner"))
      throw new OrbUnavailable({ reason: "no-provider", provider: "runner" });
    if (hiddenProviders?.has("runner") === true)
      throw new OrbUnavailable({
        reason: "beta-provider-off",
        provider: "runner",
      });
    const machine =
      input.runnerMachineId === undefined
        ? await defaultMachine(input.db, input.userId)
        : (await ownsMachine(input.db, input.userId, input.runnerMachineId))
          ? input.runnerMachineId
          : undefined;
    if (machine === undefined)
      throw new OrbUnavailable({ reason: "no-runner", provider: "runner" });
    return { ...deploymentPin, providerTemplate: machine };
  }
  // `pnpm dev` keeps its local behavior: no pin unless the deployment
  // serves the size, and activation fails closed.
  if (localRuntime)
    return deploymentProviders.some(
      ({ providerId }) => providerId === profile.adapter,
    )
      ? deploymentPin
      : undefined;
  const closedProviders = await input.closedProviders?.();
  // A named size one of the admin's deployment accounts runs pins that
  // account, as a connection's Thread pins its connection.
  const accountId =
    profile.runsAs === undefined
      ? undefined
      : deploymentSizeAccount(deploymentOrbs, profile.adapter, profile.id);
  if (accountId !== undefined) {
    if (closedProviders?.has(profile.adapter) === true)
      throw new OrbUnavailable({
        reason: "no-provider",
        provider: profile.adapter,
      });
    return deploymentAccountPin({
      db: input.db,
      bindings: input.bindings,
      connectors,
      accountId,
      providerId: profile.adapter as ExecutionProviderId,
      providerSize,
    });
  }
  const member = orbProviderSet({
    ...(closedProviders === undefined ? {} : { closedProviders }),
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
    ...(hiddenProviders === undefined
      ? {}
      : {
          hiddenProviders,
          presentedDeployment: presentedDeploymentProviders(
            input.bindings,
            deploymentOrbs,
          ),
        }),
    namedSizeProviders: namedSizeDeploymentProviders(
      input.bindings,
      deploymentOrbs,
    ),
    accountProviders: accountDeploymentProviders(deploymentOrbs),
    // A named size runs only on the deployment's account that names it;
    // a provider's own size never does.
  }).find(
    (candidate) =>
      candidate.providerId === profile.adapter &&
      (candidate.namedSizes === true) === (profile.runsAs !== undefined),
  );
  if (member === undefined)
    throw new OrbUnavailable({
      reason:
        hiddenProviders?.has(profile.adapter) === true
          ? "beta-provider-off"
          : "no-provider",
      provider: profile.adapter,
    });
  if (member.status !== "ready")
    throw new OrbUnavailable({
      reason: member.status === "failed" ? "failed" : "preparing",
    });
  if (member.scope === "deployment") {
    const connector = connectors[profile.adapter as ExecutionProviderId];
    if (!deploymentPrepared(profile.adapter) || connector === undefined)
      return deploymentPin;
    // The deployment's own account, prepared once for every person.
    const served = await deploymentTargets(
      input.db,
      profile.adapter,
      connector,
    );
    if (served.status !== "ready") {
      await scheduleDeploymentPreparation(
        input.bindings,
        profile.adapter as ExecutionProviderId,
      );
      throw new OrbUnavailable({ reason: served.status });
    }
    const target = served.targets[providerSize];
    if (target === undefined)
      throw new OrbUnavailable({
        reason: served.unavailable.has(providerSize)
          ? "size-unavailable"
          : "preparing",
      });
    return { ...deploymentPin, providerTemplate: target };
  }
  const target = member.targets?.get(profile.id);
  // The account cannot run this size (its plan refused it).
  if (target === undefined && member.targets !== undefined)
    throw new OrbUnavailable({ reason: "size-unavailable" });
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

/**
 * The pin of a Thread on one of the admin's deployment accounts: the
 * account's connection, ready for this build, with the target its
 * preparation made for the provider size. A connection preparing for an
 * earlier recipe keeps serving the version it last made ready, and one left
 * on an old recipe or stalled is started again here, so a new release never
 * waits for an admin to open the panel.
 */
const deploymentAccountPin = async (input: {
  readonly db: D1Database;
  readonly bindings: Bindings;
  readonly connectors: OrbProviderConnectors;
  readonly accountId: string;
  readonly providerId: ExecutionProviderId;
  readonly providerSize: string;
}): Promise<ThreadExecutionPin> => {
  const connector = input.connectors[input.providerId];
  const key = {
    scope: "deployment" as const,
    targetId: input.accountId,
    providerId: input.providerId,
  };
  const found =
    connector === undefined ? undefined : await findConnection(input.db, key);
  if (connector === undefined || found === undefined)
    throw new OrbUnavailable({
      reason: "no-provider",
      provider: input.providerId,
    });
  const { connection } = found;
  const recipe = await connector.recipe();
  // A null recipe is a restart whose first step is due.
  const stalled =
    (connection.recipe !== null && connection.recipe !== recipe) ||
    (connection.status === "preparing" &&
      Date.parse(connection.updatedAt) < Date.now() - PREPARATION_STALL_MS);
  if (
    stalled &&
    connection.status !== "failed" &&
    (await restartPreparation(input.db, connection, connector))
  )
    await schedulePreparation(input.bindings, key);
  const member = connectionMember(connection, {
    recipes: new Map([[input.providerId, recipe]]),
    connectors: input.connectors,
  });
  if (member.status !== "ready")
    throw new OrbUnavailable({
      reason: member.status === "failed" ? "failed" : "preparing",
    });
  const target = member.targets?.get(input.providerSize);
  if (target === undefined || member.account === null)
    throw new OrbUnavailable({
      reason: member.targets === undefined ? "preparing" : "size-unavailable",
    });
  return {
    provider: input.providerId as ThreadExecutionPin["provider"],
    runnerProfileId: input.providerSize,
    credentialScope: "deployment",
    credentialOwnerId: input.accountId,
    credentialAccount: member.account,
    providerTemplate: target,
  };
};
