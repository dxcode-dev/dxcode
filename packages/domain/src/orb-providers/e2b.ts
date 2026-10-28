import { Schema } from "effect";
import e2bOrbProfiles from "../../e2b-orb-profiles.json" with { type: "json" };
import {
  ORB_RUNNER_CAPABILITIES,
  RunnerProfileFields,
  RunnerProfileId,
  RunnerProfileLabel,
  RunnerResources,
} from "../settings/runner-profile-fields.js";
import { defineOrbProvider } from "./descriptor.js";

const E2BTemplate = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/),
);

export const E2BRunnerProfileConfiguration = Schema.Struct({
  ...RunnerProfileFields,
  adapter: Schema.Literal("e2b"),
  template: E2BTemplate,
});

export type E2BRunnerProfileConfiguration =
  typeof E2BRunnerProfileConfiguration.Type;

/**
 * E2B allocates CPU and memory when a template is built, rather than on
 * Sandbox.create. Every offered Orb profile therefore owns a distinct
 * prebuilt template; `template` is the provider input used at creation time.
 */
export const E2BOrbProfile = Schema.Struct({
  id: RunnerProfileId,
  label: RunnerProfileLabel,
  templateSuffix: Schema.String,
  resources: RunnerResources,
});

export type E2BOrbProfile = typeof E2BOrbProfile.Type;

export const E2B_ORB_PROFILES = Schema.decodeUnknownSync(
  Schema.Array(E2BOrbProfile),
)(e2bOrbProfiles);

export const e2bOrbProvider = defineOrbProvider({
  id: "e2b",
  displayName: "E2B",
  // Claims only what dx implements on E2B today. E2B's snapshot and
  // metrics APIs back execution.snapshot and execution.usage later.
  capabilities: [
    "execution.workspace",
    "execution.resident-daemon",
    "execution.pause-resume",
  ],
  // A timeout pause keeps the sandbox's processes and memory.
  pauseResumePreserves: "processes",
  remote: true,
  deployment: { secret: "E2B_API_KEY" },
  profile: E2BRunnerProfileConfiguration,
  isolation: "sandbox",
  requiredCapabilities: ORB_RUNNER_CAPABILITIES,
  // A connection's Threads create from the template built into the team, so
  // the template here is never created from on a connection.
  sizes: E2B_ORB_PROFILES.map((profile) => ({
    id: profile.id,
    label: profile.label,
    adapter: "e2b" as const,
    template: `dx-orb-${profile.templateSuffix}`,
    resources: profile.resources,
    isolation: "sandbox" as const,
    availability: "available" as const,
    capabilities: ORB_RUNNER_CAPABILITIES,
  })),
  withTarget: (profile, template) => ({ ...profile, template }),
});
