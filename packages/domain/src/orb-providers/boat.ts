import { Schema } from "effect";
import {
  ORB_RUNNER_CAPABILITIES,
  RunnerProfileFields,
  RunnerProfileId,
  RunnerProfileLabel,
  RunnerResources,
} from "../settings/runner-profile-fields.js";
import { defineOrbProvider } from "./descriptor.js";

/** A Boat sandbox type (docs.boat.dev/machines); `default` is the medium. */
export const BoatMachineType = Schema.Literals([
  "small",
  "default",
  "large",
  "xlarge",
]);

export type BoatMachineType = typeof BoatMachineType.Type;

/**
 * A Boat saved snapshot name: 1-63 lowercase letters, digits, or dashes,
 * starting with a letter or digit (`POST /saved-snapshots`).
 */
const BoatSavedSnapshot = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}$/),
);

export const BoatRunnerProfileConfiguration = Schema.Struct({
  ...RunnerProfileFields,
  adapter: Schema.Literal("boat"),
  /** The Boat sandbox type this size creates. */
  machineType: BoatMachineType,
  /**
   * The dx Orb saved snapshot a connection's preparation made, from the
   * Thread's pin. One snapshot serves every size. Absent before a Thread
   * pins one.
   */
  snapshot: Schema.optional(BoatSavedSnapshot),
});

export type BoatRunnerProfileConfiguration =
  typeof BoatRunnerProfileConfiguration.Type;

export const BoatOrbSize = Schema.Struct({
  id: RunnerProfileId,
  label: RunnerProfileLabel,
  machineType: BoatMachineType,
  resources: RunnerResources,
});

export type BoatOrbSize = typeof BoatOrbSize.Type;

/**
 * Boat's four sandbox types as Orb sizes (docs.boat.dev/machines,
 * 2026-10-24). The disk is the room for the workspace's own files.
 * `bt.xlarge` needs Boat's $100 plan; preparation records which types the
 * account can create.
 */
export const BOAT_ORB_SIZES = Schema.decodeUnknownSync(
  Schema.Array(BoatOrbSize),
)([
  {
    id: "bt.small",
    label: "small",
    machineType: "small",
    resources: { cpuCores: 2, memoryMb: 4096, diskGb: 12 },
  },
  {
    id: "bt.medium",
    label: "medium",
    machineType: "default",
    resources: { cpuCores: 4, memoryMb: 8192, diskGb: 50 },
  },
  {
    id: "bt.large",
    label: "large",
    machineType: "large",
    resources: { cpuCores: 8, memoryMb: 16384, diskGb: 125 },
  },
  {
    id: "bt.xlarge",
    label: "xlarge",
    machineType: "xlarge",
    resources: { cpuCores: 16, memoryMb: 32768, diskGb: 251 },
  },
]);

export const boatOrbProvider = defineOrbProvider({
  id: "boat",
  displayName: "Boat",
  capabilities: [
    "execution.workspace",
    "execution.resident-daemon",
    "execution.pause-resume",
  ],
  // Boat has no pause: a stop keeps the disk and ends every process, and
  // enabled systemd services (the Orb's dx-orb-init) start again on resume.
  pauseResumePreserves: "filesystem",
  remote: true,
  profile: BoatRunnerProfileConfiguration,
  isolation: "sandbox",
  requiredCapabilities: ORB_RUNNER_CAPABILITIES,
  sizes: BOAT_ORB_SIZES.map((size) => ({
    id: size.id,
    label: size.label,
    adapter: "boat" as const,
    machineType: size.machineType,
    resources: size.resources,
    isolation: "sandbox" as const,
    availability: "available" as const,
    capabilities: ORB_RUNNER_CAPABILITIES,
  })),
  withTarget: (profile, snapshot) => ({ ...profile, snapshot }),
});
