import {
  type RunnerAdapterCapabilityState,
  type RunnerProfile,
  type RunnerProfileCatalog,
  RunnerProfileCatalogConfiguration,
  type RunnerProfileId,
} from "@dx/domain";
import { Effect, Schema } from "effect";
import type { Bindings } from "../../http/types.js";

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

export const decodeRunnerProfileCatalog = Effect.fn(
  "decodeRunnerProfileCatalog",
)(function* (input: string) {
  const configuration = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(RunnerProfileCatalogConfiguration),
  )(input).pipe(
    Effect.mapError(() => new RunnerProfileConfigurationUnavailable()),
  );
  const configuredAdapters = new Set(
    configuration.profiles.map(({ adapter }) => adapter),
  );
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
          kind: "local",
          state: configuredAdapters.has("local") ? "available" : "unavailable",
        },
        ...unavailableAdapterStates,
      ],
    },
  } satisfies LoadedRunnerProfileCatalog;
});

export const loadRunnerProfileCatalog = Effect.fn("loadRunnerProfileCatalog")(
  function* (bindings: Bindings) {
    const input = bindings.DX_RUNNER_PROFILE_CATALOG;
    if (input === undefined || input.length === 0) {
      return yield* new RunnerProfileConfigurationUnavailable();
    }
    return yield* decodeRunnerProfileCatalog(input);
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
