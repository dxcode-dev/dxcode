import { Schema } from "effect";
import {
  findOrbProvider,
  ORB_PROVIDER_IDS,
  OrbRunnerProfileConfiguration,
} from "../orb-providers/index.js";
import { ExecutionPauseResumePreserves } from "../plugins/execution.js";
import {
  RunnerProfileFields,
  RunnerProfileId,
} from "./runner-profile-fields.js";

export {
  CLOUDFLARE_ORB_PROFILES,
  CloudflareContainerInstance,
  CloudflareOrbProfile,
  CloudflareRunnerProfileConfiguration,
} from "../orb-providers/cloudflare.js";
export {
  E2B_ORB_PROFILES,
  E2BOrbProfile,
  E2BRunnerProfileConfiguration,
} from "../orb-providers/e2b.js";
export {
  FREESTYLE_ORB_SIZES,
  FreestyleOrbSize,
  FreestyleRunnerProfileConfiguration,
} from "../orb-providers/freestyle.js";
export { LocalRunnerProfileConfiguration } from "../orb-providers/local.js";
export {
  RunnerCapability,
  RunnerIsolation,
  RunnerProfileAvailability,
  RunnerProfileId,
  RunnerResources,
} from "./runner-profile-fields.js";

/**
 * Every Orb provider's adapter, plus kinds reserved for runners dx does not
 * implement (always unavailable).
 */
export const RunnerAdapterKind = Schema.Literals([
  ...ORB_PROVIDER_IDS,
  "container",
  "kubernetes",
  "remote",
]);

export type RunnerAdapterKind = typeof RunnerAdapterKind.Type;

export const RunnerAdapterCapabilityState = Schema.Struct({
  kind: RunnerAdapterKind,
  state: Schema.Literals(["available", "unavailable"]),
});

export type RunnerAdapterCapabilityState =
  typeof RunnerAdapterCapabilityState.Type;

export const RunnerProfile = Schema.Struct({
  ...RunnerProfileFields,
  adapter: RunnerAdapterKind,
});

export type RunnerProfile = typeof RunnerProfile.Type;

/**
 * A deployment's size catalog (`DX_RUNNER_PROFILE_CATALOG`). Each profile
 * has the isolation and capabilities its provider's descriptor requires,
 * and never `commit-signing`.
 */
export const RunnerProfileCatalogConfiguration = Schema.Struct({
  version: Schema.Literal(1),
  defaultProfileId: RunnerProfileId,
  profiles: Schema.Array(OrbRunnerProfileConfiguration).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(32),
  ),
}).check(
  Schema.makeFilter((catalog) => {
    const ids = new Set(catalog.profiles.map(({ id }) => id));
    const defaultProfile = catalog.profiles.find(
      ({ id }) => id === catalog.defaultProfileId,
    );
    return (
      ids.size === catalog.profiles.length &&
      defaultProfile?.availability === "available" &&
      catalog.profiles.every((profile) => {
        const capabilities = new Set(profile.capabilities);
        const provider = findOrbProvider(profile.adapter);
        return (
          provider !== undefined &&
          capabilities.size === profile.capabilities.length &&
          !capabilities.has("commit-signing") &&
          profile.isolation === provider.isolation &&
          provider.requiredCapabilities.every((capability) =>
            capabilities.has(capability),
          ) &&
          (provider.forbiddenCapabilities ?? []).every(
            (capability) => !capabilities.has(capability),
          )
        );
      })
    );
  }),
);

export type RunnerProfileCatalogConfiguration =
  typeof RunnerProfileCatalogConfiguration.Type;

/**
 * How the Orb picker presents the provider behind an adapter: its display
 * name, and what its `execution.pause-resume` keeps across a pause (null
 * when the provider does not pause and resume).
 */
export const RunnerProviderPresentation = Schema.Struct({
  adapter: RunnerAdapterKind,
  displayName: Schema.String,
  /**
   * The compact name the Orb picker shows ("Cloudflare"); settings pages use
   * `displayName`. Absent from a Core that predates it.
   */
  shortName: Schema.optional(Schema.String),
  pauseResume: Schema.NullOr(ExecutionPauseResumePreserves),
});

export type RunnerProviderPresentation = typeof RunnerProviderPresentation.Type;

export const RunnerProfileCatalog = Schema.Struct({
  version: Schema.Literal(1),
  defaultProfileId: RunnerProfileId,
  profiles: Schema.Array(RunnerProfile),
  adapterStates: Schema.Array(RunnerAdapterCapabilityState),
  /** One entry per adapter that has a profile, in catalog order. */
  providers: Schema.optional(Schema.Array(RunnerProviderPresentation)),
});

export type RunnerProfileCatalog = typeof RunnerProfileCatalog.Type;
