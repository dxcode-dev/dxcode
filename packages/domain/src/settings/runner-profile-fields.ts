import { Schema } from "effect";

/**
 * The runner-profile fields every Orb provider shares. Each provider's own
 * profile configuration (`orb-providers/<provider>.ts`) adds its adapter
 * literal and the fields its sizes need; `runner-profile.ts` joins them.
 */

export const RunnerProfileId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/),
).pipe(Schema.brand("@dx/RunnerProfileId"));

export type RunnerProfileId = typeof RunnerProfileId.Type;

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
export const RunnerProfileLabel = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
);
const RunnerCostLabel = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(80),
);

export const RunnerResources = Schema.Struct({
  cpuCores: CpuCores,
  memoryMb: MemoryMb,
  diskGb: DiskGb,
});

export type RunnerResources = typeof RunnerResources.Type;

/** A runner profile's fields apart from its adapter. */
export const RunnerProfileFields = {
  id: RunnerProfileId,
  label: RunnerProfileLabel,
  resources: RunnerResources,
  isolation: RunnerIsolation,
  availability: RunnerProfileAvailability,
  costLabel: Schema.optional(RunnerCostLabel),
  capabilities: Schema.Array(RunnerCapability),
} as const;

/**
 * The traits every remote Orb has: git, environment variables, internet
 * access, a persistent workspace, and pause and resume.
 */
export const ORB_RUNNER_CAPABILITIES = [
  "git",
  "environment-variables",
  "internet-access",
  "persistent-workspace",
  "pause-resume",
] as const satisfies ReadonlyArray<RunnerCapability>;
