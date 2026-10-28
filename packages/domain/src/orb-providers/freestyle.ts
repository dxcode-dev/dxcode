import { Schema } from "effect";
import {
  ORB_RUNNER_CAPABILITIES,
  RunnerProfileFields,
  RunnerProfileId,
  RunnerProfileLabel,
  RunnerResources,
} from "../settings/runner-profile-fields.js";
import { defineOrbProvider } from "./descriptor.js";

/**
 * A Freestyle snapshot: an ID, an account slug, or a public `owner/slug`.
 * A VM boots at its snapshot's hardware, so each size starts from the
 * Freestyle base snapshot of that size (docs/vms/base-snapshots).
 */
const FreestyleSnapshot = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/),
);

export const FreestyleRunnerProfileConfiguration = Schema.Struct({
  ...RunnerProfileFields,
  adapter: Schema.Literal("freestyle"),
  /** The Freestyle base snapshot preparation builds this size's Orb from. */
  baseSnapshot: FreestyleSnapshot,
  /**
   * The dx Orb snapshot a connection's preparation made for this size, from
   * the Thread's pin. Absent before a Thread pins one.
   */
  snapshot: Schema.optional(FreestyleSnapshot),
});

export type FreestyleRunnerProfileConfiguration =
  typeof FreestyleRunnerProfileConfiguration.Type;

export const FreestyleOrbSize = Schema.Struct({
  id: RunnerProfileId,
  label: RunnerProfileLabel,
  baseSnapshot: FreestyleSnapshot,
  resources: RunnerResources,
});

export type FreestyleOrbSize = typeof FreestyleOrbSize.Type;

/**
 * Freestyle's Ubuntu base snapshots as Orb sizes (2026-10-23). The Free plan
 * allows up to 4 vCPU / 8 GiB / 32 GB per VM, so `fs.large` needs Hobby or
 * Pro; preparation builds only the sizes the account's plan allows.
 */
export const FREESTYLE_ORB_SIZES = Schema.decodeUnknownSync(
  Schema.Array(FreestyleOrbSize),
)([
  {
    id: "fs.small",
    label: "small",
    baseSnapshot: "freestyle/ubuntu-sm",
    resources: { cpuCores: 2, memoryMb: 4096, diskGb: 16 },
  },
  {
    id: "fs.medium",
    label: "medium",
    baseSnapshot: "freestyle/ubuntu",
    resources: { cpuCores: 4, memoryMb: 8192, diskGb: 32 },
  },
  {
    id: "fs.large",
    label: "large",
    baseSnapshot: "freestyle/ubuntu-lg",
    resources: { cpuCores: 8, memoryMb: 16384, diskGb: 64 },
  },
]);

export const freestyleOrbProvider = defineOrbProvider({
  id: "freestyle",
  displayName: "Freestyle",
  capabilities: [
    "execution.workspace",
    "execution.resident-daemon",
    "execution.pause-resume",
  ],
  // A Freestyle pause keeps the VM's memory, so processes resume in place.
  pauseResumePreserves: "processes",
  remote: true,
  profile: FreestyleRunnerProfileConfiguration,
  isolation: "sandbox",
  requiredCapabilities: ORB_RUNNER_CAPABILITIES,
  sizes: FREESTYLE_ORB_SIZES.map((size) => ({
    id: size.id,
    label: size.label,
    adapter: "freestyle" as const,
    baseSnapshot: size.baseSnapshot,
    resources: size.resources,
    isolation: "sandbox" as const,
    availability: "available" as const,
    capabilities: ORB_RUNNER_CAPABILITIES,
  })),
  withTarget: (profile, snapshot) => ({ ...profile, snapshot }),
});
