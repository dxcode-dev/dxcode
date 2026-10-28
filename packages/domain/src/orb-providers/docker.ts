import { Schema } from "effect";
import {
  ORB_RUNNER_CAPABILITIES,
  RunnerProfileFields,
  RunnerProfileId,
  RunnerProfileLabel,
  RunnerResources,
} from "../settings/runner-profile-fields.js";
import { defineOrbProvider } from "./descriptor.js";

/** A digest-pinned OCI image reference, such as the public Orb image. */
const DockerImageRef = Schema.String.check(
  Schema.isMaxLength(256),
  Schema.isPattern(
    /^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$/,
  ),
);

export const DockerRunnerProfileConfiguration = Schema.Struct({
  ...RunnerProfileFields,
  adapter: Schema.Literal("docker"),
  /**
   * The Orb image a connection's preparation booted and tested, from the
   * Thread's pin. Absent before a Thread pins one.
   */
  image: Schema.optional(DockerImageRef),
});

export type DockerRunnerProfileConfiguration =
  typeof DockerRunnerProfileConfiguration.Type;

export const DockerOrbSize = Schema.Struct({
  id: RunnerProfileId,
  label: RunnerProfileLabel,
  resources: RunnerResources,
});

export type DockerOrbSize = typeof DockerOrbSize.Type;

/**
 * Docker Cloud Sandboxes compute sizes as Orb sizes
 * (docs.docker.com/ai/sandboxes-api/limits, 2026-10-24). The API takes the
 * CPU and memory pair; `micro` (1 CPU, 2 GiB) is too small for the Orb and
 * is not offered. Docker does not publish a disk size; a `dk.small` Thread's
 * sandbox had a 20 GB root overlay on 2026-10-27, and the larger sizes are
 * assumed to match.
 */
export const DOCKER_ORB_SIZES = Schema.decodeUnknownSync(
  Schema.Array(DockerOrbSize),
)([
  {
    id: "dk.small",
    label: "small",
    resources: { cpuCores: 2, memoryMb: 4096, diskGb: 20 },
  },
  {
    id: "dk.medium",
    label: "medium",
    resources: { cpuCores: 4, memoryMb: 8192, diskGb: 20 },
  },
  {
    id: "dk.large",
    label: "large",
    resources: { cpuCores: 8, memoryMb: 16384, diskGb: 20 },
  },
  {
    id: "dk.xl",
    label: "xl",
    resources: { cpuCores: 16, memoryMb: 32768, diskGb: 20 },
  },
]);

export const dockerOrbProvider = defineOrbProvider({
  id: "docker",
  displayName: "Docker Cloud Sandboxes",
  shortName: "Docker",
  capabilities: [
    "execution.workspace",
    "execution.resident-daemon",
    "execution.pause-resume",
  ],
  // Docker records per sandbox whether a stop keeps memory
  // (`stopMemoryOutcome`); only the disk is guaranteed, and processes
  // restart from the image entrypoint when they are not kept.
  pauseResumePreserves: "filesystem",
  remote: true,
  profile: DockerRunnerProfileConfiguration,
  // Each sandbox is a microVM with its own kernel.
  isolation: "sandbox",
  requiredCapabilities: ORB_RUNNER_CAPABILITIES,
  sizes: DOCKER_ORB_SIZES.map((size) => ({
    id: size.id,
    label: size.label,
    adapter: "docker" as const,
    resources: size.resources,
    isolation: "sandbox" as const,
    availability: "available" as const,
    capabilities: ORB_RUNNER_CAPABILITIES,
  })),
  withTarget: (profile, image) => ({ ...profile, image }),
});
