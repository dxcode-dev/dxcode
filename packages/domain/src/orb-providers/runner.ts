import { Schema } from "effect";
import {
  type RunnerCapability,
  RunnerProfileFields,
  RunnerProfileId,
  RunnerProfileLabel,
} from "../settings/runner-profile-fields.js";
import { defineOrbProvider } from "./descriptor.js";

/** A paired machine: `rnm_` and 24 lowercase hex characters. */
const RunnerMachineTarget = Schema.String.check(
  Schema.isPattern(/^rnm_[0-9a-f]{24}$/),
);

export const RunnerRunnerProfileConfiguration = Schema.Struct({
  ...RunnerProfileFields,
  adapter: Schema.Literal("runner"),
  /** The person's machine the Thread pinned; absent before a Thread pins one. */
  machine: Schema.optional(RunnerMachineTarget),
});

export type RunnerRunnerProfileConfiguration =
  typeof RunnerRunnerProfileConfiguration.Type;

const RUNNER_CAPABILITIES = [
  "git",
  "environment-variables",
  "internet-access",
  "persistent-workspace",
] as const satisfies ReadonlyArray<RunnerCapability>;

/**
 * A person's own Mac or Linux machine ("runner"): `dxd runner` there dials out
 * to dx and runs each Thread in its own folder under ~/.dx/threads. Many
 * Threads share one machine, dx installs nothing on it, and its Terminal
 * and Desktop are never shared. Its one size names no resources; each
 * Thread pins the machine it runs on.
 */
export const runnerOrbProvider = defineOrbProvider({
  id: "runner",
  displayName: "Runners",
  shortName: "Runner",
  capabilities: ["execution.workspace", "execution.resident-daemon"],
  remote: false,
  betaFeature: "orb-provider-runner",
  // Every deployment that binds the runner session object offers runners;
  // the person's own machine is the account, so nobody is billed for it.
  deployment: { binding: "RUNNER_SESSION" },
  profile: RunnerRunnerProfileConfiguration,
  isolation: "sandbox",
  requiredCapabilities: RUNNER_CAPABILITIES,
  forbiddenCapabilities: ["pause-resume"],
  sizes: [
    {
      id: Schema.decodeUnknownSync(RunnerProfileId)("rn.machine"),
      label: Schema.decodeUnknownSync(RunnerProfileLabel)("machine"),
      adapter: "runner" as const,
      resources: { cpuCores: 1, memoryMb: 1024, diskGb: 1 },
      isolation: "sandbox" as const,
      availability: "available" as const,
      capabilities: RUNNER_CAPABILITIES,
    },
  ],
  withTarget: (profile, machine) => ({ ...profile, machine }),
});
