import type { Bindings } from "../http/types.js";
import {
  type ExecutionProviderId,
  resolveExecutionProviders,
} from "../plugins/execution/provider.js";
import { registeredDeploymentOrbs } from "./deployment-orbs-registration.js";

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
}

export type DeploymentOrbs = Readonly<
  Partial<Record<ExecutionProviderId, DeploymentOrbSettings>>
>;

/**
 * The settings for the deployment's own account of `providerId`, when the
 * deployment installs that provider.
 */
export const deploymentOrbSettings = (
  bindings: Bindings,
  providerId: string,
  registered: DeploymentOrbs = registeredDeploymentOrbs,
): DeploymentOrbSettings | undefined => {
  const settings = registered[providerId as ExecutionProviderId];
  if (settings === undefined) return undefined;
  return resolveExecutionProviders(bindings).some(
    (provider) => provider.providerId === providerId,
  )
    ? settings
    : undefined;
};

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
    resolveExecutionProviders(bindings).flatMap(({ providerId }) =>
      registered[providerId]?.displayName === undefined ? [] : [providerId],
    ),
  );
