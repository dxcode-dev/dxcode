// A deployment registers how it presents its own provider accounts here,
// and which of them are closed to a person. Public dx registers none.
import type { DeploymentOrbs } from "./deployment-orbs.js";

export const registeredDeploymentOrbs: DeploymentOrbs = {};

export const registeredClosedOrbProviders = async (
  _bindings: unknown,
  _userId: string,
): Promise<ReadonlySet<string>> => new Set();
