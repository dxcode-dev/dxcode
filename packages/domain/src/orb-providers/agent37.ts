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
  /**
   * Agent37's instance type. `default` (omitted) shares its host's cores and
   * keeps its disks on gVisor's 9p filesystem; `vm` is a whole virtual
   * machine with its own cores and an ext4 disk, at 2.5x the compute rate.
   */
  instanceType: Schema.optional(Schema.Literals(["default", "vm"])),
});

export type Agent37RunnerProfileConfiguration =
  typeof Agent37RunnerProfileConfiguration.Type;

export const Agent37OrbSize = Schema.Struct({
  id: RunnerProfileId,
  label: RunnerProfileLabel,
  resources: RunnerResources,
  instanceType: Schema.Literals(["default", "vm"]),
});

export type Agent37OrbSize = typeof Agent37OrbSize.Type;

/**
 * Agent37's instance shapes as Orb sizes
 * (agent37.com/docs/agents-api/instance-sizing, 2026-11-16), each with its
 * largest disk. The disk is the Orb's workspace (`/home/user/workspace`);
 * the rest of the system keeps its own 10 GB layer, which Agent37 does not
 * bill.
 *
 * The shared (`default`) sizes stop at 4 vCPU and share their host's
 * cores. The VM sizes are whole virtual machines with their own cores and
 * an ext4 disk: on a clone, `pnpm install`, and compile benchmark
 * (2026-11-27), a 4 vCPU VM ran in 16 s where the shared 4 vCPU size took
 * 102 s, at 2.5x its compute price.
 */
export const AGENT37_ORB_SIZES = Schema.decodeUnknownSync(
  Schema.Array(Agent37OrbSize),
)([
  {
    id: "a37.small",
    label: "small",
    resources: { cpuCores: 2, memoryMb: 4096, diskGb: 12 },
    instanceType: "default",
  },
  {
    id: "a37.medium",
    label: "medium",
    resources: { cpuCores: 4, memoryMb: 8192, diskGb: 20 },
    instanceType: "default",
  },
  {
    id: "a37.large",
    label: "large",
    resources: { cpuCores: 4, memoryMb: 16384, diskGb: 40 },
    instanceType: "default",
  },
  {
    id: "a37.xlarge",
    label: "xlarge",
    resources: { cpuCores: 4, memoryMb: 32768, diskGb: 80 },
    instanceType: "default",
  },
  {
    id: "a37.vm-small",
    label: "VM small",
    resources: { cpuCores: 2, memoryMb: 4096, diskGb: 12 },
    instanceType: "vm",
  },
  {
    id: "a37.vm-medium",
    label: "VM medium",
    resources: { cpuCores: 4, memoryMb: 8192, diskGb: 20 },
    instanceType: "vm",
  },
  {
    id: "a37.vm-large",
    label: "VM large",
    resources: { cpuCores: 4, memoryMb: 16384, diskGb: 40 },
    instanceType: "vm",
  },
  {
    id: "a37.vm-xlarge",
    label: "VM xlarge",
    resources: { cpuCores: 4, memoryMb: 32768, diskGb: 80 },
    instanceType: "vm",
  },
  {
    id: "a37.vm-2xlarge",
    label: "VM 2xlarge",
    resources: { cpuCores: 8, memoryMb: 65536, diskGb: 100 },
    instanceType: "vm",
  },
]);

/** Agent37 prices by the month; it meters per minute at 1/730 of it an hour. */
const HOURS_PER_MONTH = 730;
const USD_PER_VCPU_MONTH = 0.8;
const USD_PER_GIB_MEMORY_MONTH = 0.7;
const USD_PER_GB_DISK_MONTH = 0.09;
/** A VM's compute meters at this multiple of the default rate; disk does not. */
const VM_COMPUTE_RATE = 2.5;

/** A size's running hour at Agent37's list price, its full disk included. */
const sizeHourUsd = ({ resources, instanceType }: Agent37OrbSize): number =>
  ((resources.cpuCores * USD_PER_VCPU_MONTH +
    (resources.memoryMb / 1024) * USD_PER_GIB_MEMORY_MONTH) *
    (instanceType === "vm" ? VM_COMPUTE_RATE : 1) +
    resources.diskGb * USD_PER_GB_DISK_MONTH) /
  HOURS_PER_MONTH;

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
  // No deployment secret: a person's or workspace's own key runs it, and a
  // hosted offer runs it on the Orb accounts its admin adds in the Admin
  // panel (owner, 2026-11-20: Orb providers come only from the panel).
  profile: Agent37RunnerProfileConfiguration,
  isolation: "sandbox",
  requiredCapabilities: ORB_RUNNER_CAPABILITIES,
  // Metered per minute while running; asleep, only the disk bills.
  pricing: {
    usdPerSizeHour: Object.fromEntries(
      AGENT37_ORB_SIZES.map((size) => [size.id, sizeHourUsd(size)]),
    ),
    source: "https://www.agent37.com/docs/agents-api/billing",
    checkedOn: "2026-11-27",
  },
  sizes: AGENT37_ORB_SIZES.map((size) => ({
    id: size.id,
    label: size.label,
    adapter: "agent37" as const,
    resources: size.resources,
    isolation: "sandbox" as const,
    availability: "available" as const,
    capabilities: ORB_RUNNER_CAPABILITIES,
    ...(size.instanceType === "vm" ? { instanceType: "vm" as const } : {}),
  })),
  withTarget: (profile, template) => ({ ...profile, template }),
});
