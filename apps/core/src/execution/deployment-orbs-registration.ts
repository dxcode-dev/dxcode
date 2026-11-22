// A deployment registers how it presents its own provider accounts here,
// and which of them are closed to a person. Public dx registers none.
import type { DeploymentOrbs } from "./deployment-orbs.js";

export const registeredDeploymentOrbs: DeploymentOrbs = {};

/** What its admin configured on top of them; public dx has nothing to add. */
export const loadRegisteredDeploymentOrbs = async (
  _bindings: unknown,
): Promise<DeploymentOrbs> => registeredDeploymentOrbs;

/** How long an idle Orb on a deployment Orb account waits to stop. */
export const registeredDeploymentAccountInactivityMs: number | undefined =
  undefined;

export const registeredClosedOrbProviders = async (
  _bindings: unknown,
  _userId: string,
): Promise<ReadonlySet<string>> => new Set();

/** What a person sees when no Orb can start; public dx says nothing more. */
export const registeredOrbsUnavailableNotice = async (
  _bindings: unknown,
  _userId: string,
): Promise<string | undefined> => undefined;
