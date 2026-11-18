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
 * An Agent37 workspace template name: 2-63 lowercase letters, digits, or
 * dashes, starting with a letter (`POST /v1/templates`). The `agent37-`
 * prefix is Agent37's own.
 */
const Agent37Template = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9-]{1,62}$/),
);

export const Agent37RunnerProfileConfiguration = Schema.Struct({
  ...RunnerProfileFields,
  adapter: Schema.Literal("agent37"),
  /**
   * The dx Orb template a connection's preparation registered in the
   * Agent37 workspace, from the Thread's pin. One template serves every
   * size. Absent before a Thread pins one.
   */
  template: Schema.optional(Agent37Template),
});

export type Agent37RunnerProfileConfiguration =
  typeof Agent37RunnerProfileConfiguration.Type;

export const Agent37OrbSize = Schema.Struct({
  id: RunnerProfileId,
  label: RunnerProfileLabel,
  resources: RunnerResources,
});

export type Agent37OrbSize = typeof Agent37OrbSize.Type;

/**
 * Agent37's four instance shapes as Orb sizes
 * (agent37.com/docs/agents-api/instance-sizing, 2026-11-16), each with its
 * largest disk. 4 vCPU is Agent37's ceiling on every shape. The disk is the
 * Orb's workspace (`/home/user/workspace`); the rest of the system keeps
 * its own 10 GB layer, which Agent37 does not bill.
 */
export const AGENT37_ORB_SIZES = Schema.decodeUnknownSync(
  Schema.Array(Agent37OrbSize),
)([
  {
    id: "a37.small",
    label: "small",
    resources: { cpuCores: 2, memoryMb: 4096, diskGb: 12 },
  },
  {
    id: "a37.medium",
    label: "medium",
    resources: { cpuCores: 4, memoryMb: 8192, diskGb: 20 },
  },
  {
    id: "a37.large",
    label: "large",
    resources: { cpuCores: 4, memoryMb: 16384, diskGb: 40 },
  },
  {
    id: "a37.xlarge",
    label: "xlarge",
    resources: { cpuCores: 4, memoryMb: 32768, diskGb: 80 },
  },
]);

/** Agent37 prices by the month; it meters per minute at 1/730 of it an hour. */
const HOURS_PER_MONTH = 730;

export const agent37OrbProvider = defineOrbProvider({
  id: "agent37",
  displayName: "Agent37",
  capabilities: [
    "execution.workspace",
    "execution.resident-daemon",
    "execution.pause-resume",
  ],
  // Agent37's sleep checkpoints the instance with its memory, and the next
  // request or start wakes it with every process where it was.
  pauseResumePreserves: "processes",
  remote: true,
  // Optional: a deployment with AGENT37_API_KEY runs Agent37 on its own
  // account, as a hosted offer does.
  deployment: { secret: "AGENT37_API_KEY", prepared: true },
  profile: Agent37RunnerProfileConfiguration,
  isolation: "sandbox",
  requiredCapabilities: ORB_RUNNER_CAPABILITIES,
  // Metered per minute while running; asleep, only the disk bills.
  pricing: {
    usdPerVcpuHour: 0.8 / HOURS_PER_MONTH,
    usdPerGibMemoryHour: 0.7 / HOURS_PER_MONTH,
    usdPerGbDiskHour: 0.09 / HOURS_PER_MONTH,
    source: "https://www.agent37.com/docs/agents-api/billing",
    checkedOn: "2026-11-16",
  },
  sizes: AGENT37_ORB_SIZES.map((size) => ({
    id: size.id,
    label: size.label,
    adapter: "agent37" as const,
    resources: size.resources,
    isolation: "sandbox" as const,
    availability: "available" as const,
    capabilities: ORB_RUNNER_CAPABILITIES,
  })),
  withTarget: (profile, template) => ({ ...profile, template }),
});
