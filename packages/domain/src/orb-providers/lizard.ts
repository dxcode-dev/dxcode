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
 * A Lizard sandbox size as its API names it (`mini`, `small`, `medium`,
 * `large`, or a size an Enterprise arrangement adds). A string, so a new
 * size needs only a row in `LIZARD_SIZE_CATALOG`.
 */
export const LizardSize = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9-]{0,31}$/),
);

export type LizardSize = typeof LizardSize.Type;

/** A Lizard sandbox snapshot ID. */
const LizardSnapshot = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
);

export const LizardRunnerProfileConfiguration = Schema.Struct({
  ...RunnerProfileFields,
  adapter: Schema.Literal("lizard"),
  /** The Lizard sandbox size this Orb size creates. */
  size: LizardSize,
  /**
   * The dx Orb snapshot the deployment's preparation made for this size,
   * from the Thread's pin. A snapshot restores at its source's size, so
   * each size has its own. Absent before a Thread pins one.
   */
  snapshot: Schema.optional(LizardSnapshot),
});

export type LizardRunnerProfileConfiguration =
  typeof LizardRunnerProfileConfiguration.Type;

export const LizardSizeEntry = Schema.Struct({
  /** The Orb size ID, `lz.<size>`. */
  id: RunnerProfileId,
  label: RunnerProfileLabel,
  /** The size Lizard's API creates. */
  size: LizardSize,
  resources: RunnerResources,
  /** What Lizard charges dx for an hour of it running, in US dollars. */
  usdPerHour: Schema.Finite.check(Schema.isGreaterThan(0)),
});

export type LizardSizeEntry = typeof LizardSizeEntry.Type;

/**
 * Every Lizard sandbox size dx offers, smallest first: the one place a size
 * is added, removed, or repriced (a new size Lizard ships, or a custom
 * Enterprise arrangement). The descriptor's sizes and prices, preparation's
 * snapshots, and a deployment's own rates (a hosted offer's prices) all derive
 * from it.
 *
 * Lizard's list (lizard.build/pricing, 2026-11-11): billed per second while
 * running, nothing while paused. Nano and Mini have a 5 GB disk and start
 * only from some templates; Lizard's trial runs Nano, Mini and Small, and
 * Medium and Large after the first payment. Preparation marks a size the
 * account cannot start, or whose Orb fails dx-orb-check (Mini's 1 vCPU
 * starts the Desktop too slowly), unavailable with the reason, and a plan
 * change brings it back.
 */
export const LIZARD_SIZE_CATALOG = Schema.decodeUnknownSync(
  Schema.Array(LizardSizeEntry),
)([
  {
    id: "lz.nano",
    label: "nano",
    size: "nano",
    resources: { cpuCores: 0.5, memoryMb: 1024, diskGb: 5 },
    usdPerHour: 0.00405,
  },
  {
    id: "lz.mini",
    label: "mini",
    size: "mini",
    resources: { cpuCores: 1, memoryMb: 2048, diskGb: 5 },
    usdPerHour: 0.0081,
  },
  {
    id: "lz.small",
    label: "small",
    size: "small",
    resources: { cpuCores: 2, memoryMb: 4096, diskGb: 20 },
    usdPerHour: 0.0162,
  },
  {
    id: "lz.medium",
    label: "medium",
    size: "medium",
    resources: { cpuCores: 4, memoryMb: 8192, diskGb: 40 },
    usdPerHour: 0.0324,
  },
  {
    id: "lz.large",
    label: "large",
    size: "large",
    resources: { cpuCores: 8, memoryMb: 16384, diskGb: 80 },
    usdPerHour: 0.0648,
  },
]);

export const lizardOrbProvider = defineOrbProvider({
  id: "lizard",
  displayName: "Lizard",
  capabilities: [
    "execution.workspace",
    "execution.resident-daemon",
    "execution.pause-resume",
  ],
  // A Lizard pause keeps files only and the resume boots fresh (memory
  // pauses are off since 2026-11-10); systemd starts the Orb's dx-orb-init
  // again, and the handle reports when (`processesStartedAt`).
  pauseResumePreserves: "filesystem",
  remote: true,
  // Only a deployment's own Lizard account runs it (a hosted offer): people and
  // workspaces never connect their own.
  deploymentOnly: true,
  deployment: {
    secret: "LIZARD_API_KEY",
    prepared: true,
    // The key's project (an API key reaches every project of its
    // workspace), and optionally the region new sandboxes run in.
    settings: { projectId: "LIZARD_PROJECT_ID", region: "LIZARD_REGION" },
  },
  profile: LizardRunnerProfileConfiguration,
  isolation: "sandbox",
  requiredCapabilities: ORB_RUNNER_CAPABILITIES,
  pricing: {
    usdPerSizeHour: Object.fromEntries(
      LIZARD_SIZE_CATALOG.map(({ id, usdPerHour }) => [id, usdPerHour]),
    ),
    source: "https://lizard.build/pricing",
    checkedOn: "2026-11-11",
  },
  sizes: LIZARD_SIZE_CATALOG.map((size) => ({
    id: size.id,
    label: size.label,
    adapter: "lizard" as const,
    size: size.size,
    resources: size.resources,
    isolation: "sandbox" as const,
    availability: "available" as const,
    capabilities: ORB_RUNNER_CAPABILITIES,
  })),
  withTarget: (profile, snapshot) => ({ ...profile, snapshot }),
});
