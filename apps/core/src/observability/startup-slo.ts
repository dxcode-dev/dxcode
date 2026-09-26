import { Schema } from "effect";
import { StartupPhaseOutcome } from "./startup-phase.js";

export interface StartupLatencySloTarget {
  readonly p95Ms: number;
  readonly p99Ms?: number;
  readonly minimumSuccessRate?: number;
  readonly releaseCeilingMs:
    | number
    | { readonly cold: number; readonly warm: number };
}

export const startupSloTargets = {
  threadCreate: { p95Ms: 1_000, p99Ms: 2_000, releaseCeilingMs: 2_000 },
  submissionAdmission: {
    p95Ms: 500,
    p99Ms: 1_000,
    releaseCeilingMs: 1_000,
  },
  scheduling: { p95Ms: 1_000, p99Ms: 2_000, releaseCeilingMs: 2_000 },
  sourceBackedModelRequest: {
    p95Ms: 5_000,
    p99Ms: 10_000,
    minimumSuccessRate: 0.99,
    releaseCeilingMs: 10_000,
  },
  sourceBackedFirstToken: {
    p95Ms: 10_000,
    p99Ms: 15_000,
    minimumSuccessRate: 0.99,
    releaseCeilingMs: { cold: 15_000, warm: 10_000 },
  },
  contextDiscovery: {
    p95Ms: 1_000,
    minimumSuccessRate: 1,
    releaseCeilingMs: 2_000,
  },
  terminalWarm: {
    p95Ms: 2_000,
    p99Ms: 4_000,
    minimumSuccessRate: 0.99,
    releaseCeilingMs: 4_000,
  },
  terminalWake: {
    p95Ms: 10_000,
    p99Ms: 15_000,
    minimumSuccessRate: 0.99,
    releaseCeilingMs: 15_000,
  },
} as const satisfies Record<string, StartupLatencySloTarget>;

export const startupSettlementTarget = {
  minimumSuccessRate: 0.999,
  maximumOpenMs: 15 * 60 * 1_000,
} as const;

const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const StartupSloSample = Schema.Struct({
  outcome: StartupPhaseOutcome,
  durationMs: NonNegativeInteger,
});
export type StartupSloSample = typeof StartupSloSample.Type;

export interface StartupSloEvaluation {
  readonly eligible: number;
  readonly reached: number;
  readonly successRate: number;
  readonly p95Ms: number | undefined;
  readonly p99Ms: number | undefined;
  readonly meetsObjective: boolean;
}

export const nearestRank = (
  values: ReadonlyArray<number>,
  percentile: number,
): number | undefined => {
  if (!Number.isFinite(percentile) || percentile <= 0 || percentile > 100) {
    throw new RangeError("Percentile must be greater than 0 and at most 100.");
  }
  if (values.length === 0) return undefined;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.ceil((percentile / 100) * ordered.length) - 1];
};

export const evaluateStartupSlo = (
  samples: ReadonlyArray<StartupSloSample>,
  target: StartupLatencySloTarget,
): StartupSloEvaluation => {
  const reachedSamples = samples.filter(({ outcome }) => outcome === "reached");
  const reached = reachedSamples.length;
  const successRate = samples.length === 0 ? 0 : reached / samples.length;
  const durations = reachedSamples.map(({ durationMs }) => durationMs);
  const p95Ms = nearestRank(durations, 95);
  const p99Ms = nearestRank(durations, 99);
  return {
    eligible: samples.length,
    reached,
    successRate,
    p95Ms,
    p99Ms,
    meetsObjective:
      p95Ms !== undefined &&
      p99Ms !== undefined &&
      p95Ms <= target.p95Ms &&
      (target.p99Ms === undefined || p99Ms <= target.p99Ms) &&
      (target.minimumSuccessRate === undefined ||
        successRate >= target.minimumSuccessRate),
  };
};
