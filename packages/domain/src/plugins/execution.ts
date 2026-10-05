import { Schema } from "effect";
import type { RunnerCapability } from "../settings/runner-profile.js";

/**
 * The Execution ("Orb") plugin's capabilities: the isolated workspace each
 * Thread runs in. Execution is a required slot, and a Thread's workspace is
 * fixed for its lifetime. A capability is an operation family Core calls; a
 * provider has it only when it both claims and implements it.
 *
 * - `execution.workspace` (required): a per-Thread, persistent, isolated
 *   filesystem and command runner (Flue's SandboxDriver) with per-command
 *   environment, created on first activation and reconnected afterwards.
 * - `execution.resident-daemon`: the provider runs dx's static Linux dxd
 *   binary as a long-lived process that reaches Core. dxd serves Terminal,
 *   Files, resident Changes refresh, environment refresh, and workload
 *   identity; the dxd protocol itself is core, not part of any provider.
 * - `execution.pause-resume`: the workspace survives idleness and archive,
 *   and the next activation resumes it. Its `preserves` trait says how much
 *   survives (see `ExecutionPauseResumePreserves`).
 * - `execution.snapshot`: capture a prepared workspace and create new
 *   workspaces from it (the project warm cache). No provider implements it yet.
 * - `execution.usage`: the provider reports a workspace's resources and
 *   running time. Cost is never provider-reported. No provider implements it yet.
 * - `execution.display`: reserved for a live desktop stream; every provider
 *   is unsupported.
 *
 * Persistence, environment variables, and git are not capabilities: every
 * workspace has them. Internet access is a runner-profile network trait.
 */
export const EXECUTION_CAPABILITY_IDS = [
  "execution.workspace",
  "execution.resident-daemon",
  "execution.pause-resume",
  "execution.snapshot",
  "execution.usage",
  "execution.display",
] as const;

export const ExecutionCapabilityId = Schema.Literals(EXECUTION_CAPABILITY_IDS);

export type ExecutionCapabilityId = typeof ExecutionCapabilityId.Type;

/**
 * What `execution.pause-resume` keeps across a pause, shown next to the
 * provider: `processes` (warm: processes and memory survive, as on E2B) or
 * `filesystem` (cold: the filesystem survives and processes restart from the
 * image entrypoint, as with Cloudflare Containers snapshots). Each provider
 * that claims `execution.pause-resume` declares it in the plugin registry,
 * and the Orb picker shows it next to the provider.
 */
export const ExecutionPauseResumePreserves = Schema.Literals([
  "processes",
  "filesystem",
]);

export type ExecutionPauseResumePreserves =
  typeof ExecutionPauseResumePreserves.Type;

/**
 * What a runner-profile capability (the user-facing descriptor) requires of
 * the provider: an execution capability, nothing (a trait every workspace
 * has, or a network setting), or refusal (`commit-signing`, which the
 * catalog rejects for every adapter).
 */
const runnerCapabilityRequirement = {
  git: null,
  "environment-variables": null,
  "persistent-workspace": null,
  "internet-access": null,
  "pause-resume": "execution.pause-resume",
  "commit-signing": "refused",
} as const satisfies Record<
  RunnerCapability,
  ExecutionCapabilityId | null | "refused"
>;

/**
 * The execution capabilities a runner profile relies on: always the
 * workspace, plus pause-resume when the profile offers it. `undefined` when
 * the profile offers something no provider can satisfy.
 */
export const executionCapabilitiesForRunnerProfile = (
  capabilities: ReadonlyArray<RunnerCapability>,
): ReadonlyArray<ExecutionCapabilityId> | undefined => {
  const required: Array<ExecutionCapabilityId> = ["execution.workspace"];
  for (const capability of capabilities) {
    const requirement = runnerCapabilityRequirement[capability];
    if (requirement === "refused") return undefined;
    if (requirement !== null) required.push(requirement);
  }
  return required;
};
