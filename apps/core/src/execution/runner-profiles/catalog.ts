import {
  CLOUDFLARE_ORB_PROFILES,
  E2B_ORB_PROFILES,
  type RunnerAdapterCapabilityState,
  type RunnerProfile,
  type RunnerProfileCatalog,
  RunnerProfileCatalogConfiguration,
  RunnerProfileId,
} from "@dx/domain";
import { Effect, Schema } from "effect";
import type { Bindings } from "../../http/types.js";
import {
  findPlugin,
  findProvider,
  isLocalRuntime,
} from "../../plugins/registry.js";

const unavailableAdapterStates = [
  { kind: "container", state: "unavailable" },
  { kind: "kubernetes", state: "unavailable" },
  { kind: "remote", state: "unavailable" },
] as const satisfies ReadonlyArray<RunnerAdapterCapabilityState>;

export class RunnerProfileConfigurationUnavailable extends Schema.TaggedError<RunnerProfileConfigurationUnavailable>()(
  "RunnerProfileConfigurationUnavailable",
  {},
) {}

export class RunnerProfileUnavailable extends Schema.TaggedError<RunnerProfileUnavailable>()(
  "RunnerProfileUnavailable",
  { runnerProfileId: Schema.optional(Schema.String) },
) {}

export interface LoadedRunnerProfileCatalog {
  readonly configuration: typeof RunnerProfileCatalogConfiguration.Type;
  readonly publicCatalog: RunnerProfileCatalog;
}

const publicProfile = (
  profile: (typeof RunnerProfileCatalogConfiguration.Type.profiles)[number],
): RunnerProfile => ({
  id: profile.id,
  label: profile.label,
  adapter: profile.adapter,
  resources: profile.resources,
  isolation: profile.isolation,
  availability: profile.availability,
  ...(profile.costLabel === undefined ? {} : { costLabel: profile.costLabel }),
  capabilities: profile.capabilities,
});

type CatalogConfiguration = typeof RunnerProfileCatalogConfiguration.Type;

const orbCapabilities = [
  "git",
  "environment-variables",
  "internet-access",
  "persistent-workspace",
  "pause-resume",
] as const;

/**
 * Every provider's own sizes. A deployment's catalog lists the sizes it
 * offers on its own account with its templates. A connection's Threads
 * pin the target their account prepared, so these profiles stand in for
 * any size the deployment does not list; the E2B template here is never
 * created from.
 */
export const PROVIDER_RUNNER_PROFILES: CatalogConfiguration["profiles"] = [
  ...E2B_ORB_PROFILES.map((profile) => ({
    id: profile.id,
    label: profile.label,
    adapter: "e2b" as const,
    template: `dx-orb-${profile.templateSuffix}`,
    resources: profile.resources,
    isolation: "sandbox" as const,
    availability: "available" as const,
    capabilities: orbCapabilities,
  })),
  ...CLOUDFLARE_ORB_PROFILES.map((profile) => ({
    id: profile.id,
    label: profile.label,
    adapter: "cloudflare" as const,
    instance: profile.instance,
    resources: profile.resources,
    isolation: "container" as const,
    availability: "available" as const,
    capabilities: orbCapabilities,
  })),
];

/** The size a new project starts on when the deployment names none. */
export const DEFAULT_ORB_PROFILE_ID =
  Schema.decodeUnknownSync(RunnerProfileId)("a1.medium");

/**
 * The deployment's catalog with every provider's sizes it does not list,
 * so a size is known whichever account runs it. Who may start a Thread on
 * a size is the provider set's decision (plugins/execution/orb-providers).
 */
const withProviderProfiles = (
  configuration: CatalogConfiguration | undefined,
): CatalogConfiguration => {
  const listed = new Set(configuration?.profiles.map(({ id }) => id) ?? []);
  return {
    version: 1,
    defaultProfileId: configuration?.defaultProfileId ?? DEFAULT_ORB_PROFILE_ID,
    profiles: [
      ...(configuration?.profiles ?? []),
      ...PROVIDER_RUNNER_PROFILES.filter(({ id }) => !listed.has(id)),
    ],
  };
};

const decodeCatalogConfiguration = (input: string) =>
  Schema.decodeUnknownEffect(
    Schema.fromJsonString(RunnerProfileCatalogConfiguration),
  )(input).pipe(
    Effect.mapError(() => new RunnerProfileConfigurationUnavailable()),
  );

export const decodeRunnerProfileCatalog = Effect.fn(
  "decodeRunnerProfileCatalog",
)(function* (input: string) {
  return catalogFrom(yield* decodeCatalogConfiguration(input));
});

const catalogFrom = (
  configuration: CatalogConfiguration,
): LoadedRunnerProfileCatalog => {
  const configuredAdapters = new Set(
    configuration.profiles.map(({ adapter }) => adapter),
  );
  const execution = findPlugin("execution");
  return {
    configuration,
    publicCatalog: {
      version: 1,
      defaultProfileId: configuration.defaultProfileId,
      profiles: configuration.profiles.map(publicProfile),
      adapterStates: [
        {
          kind: "e2b",
          state: configuredAdapters.has("e2b") ? "available" : "unavailable",
        },
        {
          kind: "cloudflare",
          state: configuredAdapters.has("cloudflare")
            ? "available"
            : "unavailable",
        },
        {
          kind: "local",
          state: configuredAdapters.has("local") ? "available" : "unavailable",
        },
        ...unavailableAdapterStates,
      ],
      // The Orb picker groups sizes by provider and shows what a pause keeps.
      providers: [...configuredAdapters].map((adapter) => {
        const provider =
          execution === undefined
            ? undefined
            : findProvider(execution, adapter);
        return {
          adapter,
          displayName: provider?.displayName ?? adapter,
          shortName: provider?.shortName ?? provider?.displayName ?? adapter,
          pauseResume: provider?.capabilities.includes("execution.pause-resume")
            ? (provider.pauseResumePreserves ?? null)
            : null,
        };
      }),
    },
  };
};

/**
 * The size catalog. Deployed, it is the deployment's catalog plus every
 * provider's own sizes, so it exists with no deployment provider and no
 * `DX_RUNNER_PROFILE_CATALOG`. The local runtime keeps exactly its
 * configured catalog.
 */
export const loadRunnerProfileCatalog = Effect.fn("loadRunnerProfileCatalog")(
  function* (bindings: Bindings) {
    const input = bindings.DX_RUNNER_PROFILE_CATALOG;
    const configured =
      input === undefined || input.length === 0
        ? undefined
        : yield* decodeCatalogConfiguration(input);
    if (isLocalRuntime(bindings)) {
      if (configured === undefined)
        return yield* new RunnerProfileConfigurationUnavailable();
      return catalogFrom(configured);
    }
    return catalogFrom(withProviderProfiles(configured));
  },
);

export const selectRunnerProfile = Effect.fn("selectRunnerProfile")(function* (
  catalog: LoadedRunnerProfileCatalog,
  runnerProfileId: RunnerProfileId,
  requireAvailable = true,
) {
  const profile = catalog.configuration.profiles.find(
    ({ id }) => id === runnerProfileId,
  );
  if (
    profile === undefined ||
    (requireAvailable && profile.availability !== "available")
  ) {
    return yield* new RunnerProfileUnavailable({ runnerProfileId });
  }
  return profile;
});
