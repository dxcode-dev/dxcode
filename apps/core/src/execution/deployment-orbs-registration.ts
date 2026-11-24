// A deployment registers how it presents its own provider accounts here,
// and which of them are closed to a person. Public dx registers none.
import type { SpaceCoordinatorDefault } from "../spaces/coordinator-orb.js";
import type { DeploymentOrbs } from "./deployment-orbs.js";

export const registeredDeploymentOrbs: DeploymentOrbs = {};

/** What its admin configured on top of them; public dx has nothing to add. */
export const loadRegisteredDeploymentOrbs = async (
  _bindings: unknown,
  _withUnoffered?: boolean,
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

/**
 * The Orb a Space coordinator runs on when neither its owner nor their
 * workspace chose one: public dx has no default, so the Space is refused.
 */
export const registeredSpaceCoordinatorDefault = async (
  _bindings: unknown,
  _userId: string,
): Promise<SpaceCoordinatorDefault | undefined> => undefined;
