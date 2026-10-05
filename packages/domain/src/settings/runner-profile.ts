import { Schema } from "effect";
import cloudflareOrbProfiles from "../../cloudflare-orb-profiles.json" with {
  type: "json",
};
import e2bOrbProfiles from "../../e2b-orb-profiles.json" with { type: "json" };
import { ExecutionPauseResumePreserves } from "../plugins/execution.js";

export const RunnerProfileId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/),
).pipe(Schema.brand("@dx/RunnerProfileId"));

export type RunnerProfileId = typeof RunnerProfileId.Type;

export const RunnerAdapterKind = Schema.Literals([
  "e2b",
  "cloudflare",
  "local",
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

export const RunnerProfileAvailability = Schema.Literals([
  "available",
  "maintenance",
  "unavailable",
]);

export type RunnerProfileAvailability = typeof RunnerProfileAvailability.Type;

export const RunnerIsolation = Schema.Literals([
  "sandbox",
  "process",
  "container",
  "pod",
  "worker",
]);

export type RunnerIsolation = typeof RunnerIsolation.Type;

export const RunnerCapability = Schema.Literals([
  "git",
  "environment-variables",
  "internet-access",
  "persistent-workspace",
  "pause-resume",
  "commit-signing",
]);

export type RunnerCapability = typeof RunnerCapability.Type;

const CpuCores = Schema.Finite.check(
  Schema.isBetween({ minimum: 0.25, maximum: 128 }),
);
const MemoryMb = Schema.Int.check(
  Schema.isBetween({ minimum: 128, maximum: 1_048_576 }),
);
const DiskGb = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 65_536 }),
);
const RunnerProfileLabel = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
);
const RunnerCostLabel = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(80),
);
const E2BTemplate = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/),
);

export const RunnerResources = Schema.Struct({
  cpuCores: CpuCores,
  memoryMb: MemoryMb,
  diskGb: DiskGb,
});

export type RunnerResources = typeof RunnerResources.Type;

export const RunnerProfile = Schema.Struct({
  id: RunnerProfileId,
  label: RunnerProfileLabel,
  adapter: RunnerAdapterKind,
  resources: RunnerResources,
  isolation: RunnerIsolation,
  availability: RunnerProfileAvailability,
  costLabel: Schema.optional(RunnerCostLabel),
  capabilities: Schema.Array(RunnerCapability),
});

export type RunnerProfile = typeof RunnerProfile.Type;

export const E2BRunnerProfileConfiguration = Schema.Struct({
  ...RunnerProfile.fields,
  adapter: Schema.Literal("e2b"),
  template: E2BTemplate,
});

export type E2BRunnerProfileConfiguration =
  typeof E2BRunnerProfileConfiguration.Type;

/**
 * E2B allocates CPU and memory when a template is built, rather than on
 * Sandbox.create. Every offered Orb profile therefore owns a distinct
 * prebuilt template; `template` is the provider input used at creation time.
 */
export const E2BOrbProfile = Schema.Struct({
  id: RunnerProfileId,
  label: RunnerProfileLabel,
  templateSuffix: Schema.String,
  resources: RunnerResources,
});

export type E2BOrbProfile = typeof E2BOrbProfile.Type;

export const E2B_ORB_PROFILES = Schema.decodeUnknownSync(
  Schema.Array(E2BOrbProfile),
)(e2bOrbProfiles);

/**
 * Cloudflare Containers instance types a Thread may start with under the
 * `durable_object` scheduling policy. `lite` (256 MiB, 2 GB disk) cannot
 * hold the standard Orb image, and the runtime does not accept `basic` by
 * name, so neither is offered.
 */
export const CloudflareContainerInstance = Schema.Literals([
  "standard-1",
  "standard-2",
  "standard-3",
  "standard-4",
]);

export type CloudflareContainerInstance =
  typeof CloudflareContainerInstance.Type;

/**
 * A Cloudflare Containers Orb size. Unlike E2B, the size is chosen when the
 * container starts (`ctx.container.start({ instance })`), so a profile names
 * an instance type instead of a template; the Thread's container keeps the
 * instance it was created with.
 */
export const CloudflareRunnerProfileConfiguration = Schema.Struct({
  ...RunnerProfile.fields,
  adapter: Schema.Literal("cloudflare"),
  instance: CloudflareContainerInstance,
});

export type CloudflareRunnerProfileConfiguration =
  typeof CloudflareRunnerProfileConfiguration.Type;

/**
 * Cloudflare Containers instance types as Orb sizes (instance types from
 * developers.cloudflare.com, 2026-10-04).
 */
export const CloudflareOrbProfile = Schema.Struct({
  id: RunnerProfileId,
  label: RunnerProfileLabel,
  instance: CloudflareContainerInstance,
  resources: RunnerResources,
});

export type CloudflareOrbProfile = typeof CloudflareOrbProfile.Type;

export const CLOUDFLARE_ORB_PROFILES = Schema.decodeUnknownSync(
  Schema.Array(CloudflareOrbProfile),
)(cloudflareOrbProfiles);

export const LocalRunnerProfileConfiguration = Schema.Struct({
  ...RunnerProfile.fields,
  adapter: Schema.Literal("local"),
});

export type LocalRunnerProfileConfiguration =
  typeof LocalRunnerProfileConfiguration.Type;

const requiredE2BCapabilities = [
  "git",
  "environment-variables",
  "internet-access",
  "persistent-workspace",
  "pause-resume",
] as const satisfies ReadonlyArray<RunnerCapability>;
const requiredLocalCapabilities = [
  "git",
  "environment-variables",
  "persistent-workspace",
] as const satisfies ReadonlyArray<RunnerCapability>;

export const RunnerProfileCatalogConfiguration = Schema.Struct({
  version: Schema.Literal(1),
  defaultProfileId: RunnerProfileId,
  profiles: Schema.Array(
    Schema.Union([
      E2BRunnerProfileConfiguration,
      CloudflareRunnerProfileConfiguration,
      LocalRunnerProfileConfiguration,
    ]),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
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
        const common =
          capabilities.size === profile.capabilities.length &&
          !capabilities.has("commit-signing");
        if (!common) return false;
        if (profile.adapter === "e2b")
          return (
            profile.isolation === "sandbox" &&
            requiredE2BCapabilities.every((capability) =>
              capabilities.has(capability),
            )
          );
        // A Cloudflare container has the same workspace traits as an E2B
        // sandbox; its pause-resume keeps the filesystem only.
        if (profile.adapter === "cloudflare")
          return (
            profile.isolation === "container" &&
            requiredE2BCapabilities.every((capability) =>
              capabilities.has(capability),
            )
          );
        return (
          profile.isolation === "process" &&
          requiredLocalCapabilities.every((capability) =>
            capabilities.has(capability),
          ) &&
          !capabilities.has("internet-access") &&
          !capabilities.has("pause-resume")
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
