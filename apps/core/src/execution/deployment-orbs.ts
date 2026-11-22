import type { Bindings } from "../http/types.js";
import {
  type ExecutionProviderId,
  resolveExecutionProviders,
} from "../plugins/execution/provider.js";
import {
  loadRegisteredDeploymentOrbs,
  registeredDeploymentOrbs,
} from "./deployment-orbs-registration.js";

/**
 * How a deployment presents and runs its own account of a provider. Only
 * the deployment's account takes these; a person's or workspace's
 * connection keeps the provider's own name and idle time. Public dx
 * registers none (`deployment-orbs-registration.ts`, which the public
 * export replaces).
 */
export interface DeploymentOrbSettings {
  /** The name the Orb picker shows for the deployment's own account. */
  readonly displayName?: string;
  /** One sentence the picker shows about it, such as its limits. */
  readonly description?: string;
  /** How long an idle Orb on the deployment's account waits to stop. */
  readonly inactivityMs?: number;
  /**
   * What each size costs on the deployment's account, by size ID, as the
   * size cards show it. A size the deployment's catalog labels keeps that.
   */
  readonly costLabels?: Readonly<Record<string, string>>;
  /**
   * What the deployment's admin can change, read each time the catalog or
   * the provider list loads: its `costLabels` and `description` win over
   * the fixed ones.
   */
  readonly loadPresentation?: (bindings: Bindings) => Promise<{
    readonly costLabels?: Readonly<Record<string, string>>;
    readonly description?: string;
  }>;
  /**
   * The deployment's own named sizes for its account, each running as one
   * of the provider's sizes (`runsAs`). With them, the deployment's account
   * runs only these sizes, under `displayName`, and the provider's own sizes
   * run only on people's and workspaces' own keys, so choosing one never
   * means the other.
   */
  readonly sizes?: ReadonlyArray<DeploymentOrbSize>;
}

/** One of the deployment's own named sizes. */
export interface DeploymentOrbSize {
  readonly id: string;
  readonly label: string;
  /** The provider's size it runs as. */
  readonly runsAs: string;
  /**
   * The deployment Orb account that runs it, when its admin added one for
   * this provider (`orb_connection` at scope `deployment`, by its ID).
   * Absent: the deployment's own secret or binding runs it, which then
   * must be installed.
   */
  readonly account?: string;
}

export type DeploymentOrbs = Readonly<
  Partial<Record<ExecutionProviderId, DeploymentOrbSettings>>
>;

/**
 * The settings for the deployment's own accounts of `providerId`: every
 * size when the deployment installs the provider from a secret or binding,
 * else only the sizes one of its admin's accounts runs.
 */
export const deploymentOrbSettings = (
  bindings: Bindings,
  providerId: string,
  registered: DeploymentOrbs = registeredDeploymentOrbs,
): DeploymentOrbSettings | undefined => {
  const settings = registered[providerId as ExecutionProviderId];
  if (settings === undefined) return undefined;
  if (
    resolveExecutionProviders(bindings).some(
      (provider) => provider.providerId === providerId,
    )
  )
    return settings;
  const sizes = (settings.sizes ?? []).filter(
    ({ account }) => account !== undefined,
  );
  return sizes.length === 0 ? undefined : { ...settings, sizes };
};

/** The registered providers whose deployment accounts `bindings` can run. */
const offeredDeploymentSettings = (
  bindings: Bindings,
  registered: DeploymentOrbs,
) =>
  Object.keys(registered).flatMap((providerId) => {
    const settings = deploymentOrbSettings(bindings, providerId, registered);
    return settings === undefined ? [] : [[providerId, settings] as const];
  });

/**
 * The providers whose deployment account the deployment presents under its
 * own name, such as a hosted offer. That account is the deployment's own product,
 * so a provider's beta flag (#1924) gates only people's and workspaces'
 * connections to it, never this account.
 */
export const presentedDeploymentProviders = (
  bindings: Bindings,
  registered: DeploymentOrbs = registeredDeploymentOrbs,
): ReadonlySet<string> =>
  new Set(
    offeredDeploymentSettings(bindings, registered).flatMap(
      ([providerId, settings]) =>
        settings.displayName === undefined ? [] : [providerId],
    ),
  );

/**
 * The providers whose own deployment secret or binding runs only the
 * deployment's named sizes (`DeploymentOrbSettings.sizes` with no
 * `account`): their own sizes never fall back to it. Named sizes on an
 * admin's accounts leave the provider's own sizes on the secret alone.
 */
export const namedSizeDeploymentProviders = (
  bindings: Bindings,
  registered: DeploymentOrbs = registeredDeploymentOrbs,
): ReadonlySet<string> =>
  new Set(
    offeredDeploymentSettings(bindings, registered).flatMap(
      ([providerId, settings]) =>
        settings.sizes?.some(({ account }) => account === undefined) === true
          ? [providerId]
          : [],
    ),
  );

/**
 * The providers with a named size on one of the admin's deployment
 * accounts: the deployment offers them though no secret or binding
 * installs them.
 */
export const accountDeploymentProviders = (
  registered: DeploymentOrbs = registeredDeploymentOrbs,
): ReadonlySet<string> =>
  new Set(
    Object.entries(registered).flatMap(([providerId, settings]) =>
      settings?.sizes?.some(({ account }) => account !== undefined) === true
        ? [providerId]
        : [],
    ),
  );

/** The deployment account that runs the named size `sizeId`, if any. */
export const deploymentSizeAccount = (
  registered: DeploymentOrbs,
  providerId: string,
  sizeId: string,
): string | undefined =>
  registered[providerId as ExecutionProviderId]?.sizes?.find(
    ({ id }) => id === sizeId,
  )?.account;

/**
 * How the deployment presents its own accounts now: the registered
 * presentation with what its admin configured (which accounts run which
 * named sizes). A failed read keeps the registered one.
 */
export const loadDeploymentOrbs = async (
  bindings: Bindings,
): Promise<DeploymentOrbs> =>
  loadRegisteredDeploymentOrbs(bindings).catch(() => registeredDeploymentOrbs);

/**
 * How the deployment presents its accounts, as far as `runnerProfileId`
 * needs: only one of the deployment's named sizes (or an unknown size)
 * depends on which of its admin's accounts runs it, so any other size
 * takes the registered presentation and spends no D1 read.
 */
export const deploymentOrbsFor = (
  bindings: Bindings,
  runnerProfileId: string | undefined,
): Promise<DeploymentOrbs> =>
  runnerProfileId !== undefined &&
  !Object.values(registeredDeploymentOrbs).some((settings) =>
    settings?.sizes?.some(({ id }) => id === runnerProfileId),
  )
    ? Promise.resolve(registeredDeploymentOrbs)
    : loadDeploymentOrbs(bindings);
