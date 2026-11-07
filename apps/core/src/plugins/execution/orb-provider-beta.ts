import { orbProviderBetaFeature, type Principal } from "@dx/domain";
import type { Bindings } from "../../http/types.js";
import { enabledExperimentalFeatures } from "../../settings/experimental-features/routes.js";
import { findPlugin } from "../registry.js";

/**
 * The beta Orb providers the person has not turned on (#1924): each names
 * a personal experimental feature in its descriptor (`betaFeature`), and
 * until it is on the provider is not listed, connectable, or pinned by the
 * person's new Threads. Threads that already pinned one keep running. The
 * deployment's own account, when the deployment presents it under its own
 * name, stays offered (`presentedDeploymentProviders`). A failed
 * read hides every beta provider.
 */
export const hiddenOrbProviders = async (
  bindings: Bindings,
  principal: Principal,
): Promise<ReadonlySet<string>> => {
  const beta = (findPlugin("execution")?.providers ?? []).flatMap(({ id }) => {
    const feature = orbProviderBetaFeature(id);
    return feature === undefined ? [] : [{ id, feature }];
  });
  if (beta.length === 0) return new Set();
  const enabled: ReadonlySet<string> = await enabledExperimentalFeatures(
    bindings,
    principal,
  ).catch(() => new Set<string>());
  return new Set(
    beta.flatMap(({ id, feature }) => (enabled.has(feature) ? [] : [id])),
  );
};
