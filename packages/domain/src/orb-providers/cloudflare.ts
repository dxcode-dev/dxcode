import { Schema } from "effect";
import cloudflareOrbProfiles from "../../cloudflare-orb-profiles.json" with {
  type: "json",
};
import {
  ORB_RUNNER_CAPABILITIES,
  RunnerProfileFields,
  RunnerProfileId,
  RunnerProfileLabel,
  RunnerResources,
} from "../settings/runner-profile-fields.js";
import { defineOrbProvider } from "./descriptor.js";

/**
 * Cloudflare Containers instance types a Thread may start with under the
 * `durable_object` scheduling policy. `lite` (256 MiB, 2 GB disk) cannot
 * hold the standard Orb image, and the runtime does not accept `basic` by
 * name, so neither is offered.
 */
export const CloudflareContainerInstance = Schema.Literals([
  "standard-1",
  "standard-2",
  "standard-3",
  "standard-4",
]);

export type CloudflareContainerInstance =
  typeof CloudflareContainerInstance.Type;

/**
 * A Cloudflare Containers Orb size. Unlike E2B, the size is chosen when the
 * container starts (`ctx.container.start({ instance })`), so a profile names
 * an instance type instead of a template; the Thread's container keeps the
 * instance it was created with.
 */
export const CloudflareRunnerProfileConfiguration = Schema.Struct({
  ...RunnerProfileFields,
  adapter: Schema.Literal("cloudflare"),
  instance: CloudflareContainerInstance,
  /**
   * The account Orb Worker a connected Cloudflare account runs the Thread
   * through, from the Thread's pin; absent on the deployment's own account,
   * which binds the Orb container namespace.
   */
  endpoint: Schema.optional(
    Schema.String.check(Schema.isPattern(/^https:\/\/[^/\s]+\/$/)),
  ),
});

export type CloudflareRunnerProfileConfiguration =
  typeof CloudflareRunnerProfileConfiguration.Type;

/**
 * Cloudflare Containers instance types as Orb sizes (instance types from
 * developers.cloudflare.com, 2026-10-04).
 */
export const CloudflareOrbProfile = Schema.Struct({
  id: RunnerProfileId,
  label: RunnerProfileLabel,
  instance: CloudflareContainerInstance,
  resources: RunnerResources,
});

export type CloudflareOrbProfile = typeof CloudflareOrbProfile.Type;

export const CLOUDFLARE_ORB_PROFILES = Schema.decodeUnknownSync(
  Schema.Array(CloudflareOrbProfile),
)(cloudflareOrbProfiles);

export const cloudflareOrbProvider = defineOrbProvider({
  id: "cloudflare",
  displayName: "Cloudflare Containers",
  shortName: "Cloudflare",
  // One container per Thread, owned by a Durable Object in the deployer's
  // account or in a connected account's Orb Worker.
  capabilities: [
    "execution.workspace",
    "execution.resident-daemon",
    "execution.pause-resume",
  ],
  // A pause snapshots the filesystem and stops the container; processes
  // restart from the image entrypoint on wake.
  pauseResumePreserves: "filesystem",
  // Runs in the deployer's or the person's own Cloudflare account.
  remote: false,
  deployment: { binding: "ORB_CONTAINER" },
  profile: CloudflareRunnerProfileConfiguration,
  // A Cloudflare container has the same workspace traits as an E2B
  // sandbox; its pause-resume keeps the filesystem only.
  isolation: "container",
  requiredCapabilities: ORB_RUNNER_CAPABILITIES,
  sizes: CLOUDFLARE_ORB_PROFILES.map((profile) => ({
    id: profile.id,
    label: profile.label,
    adapter: "cloudflare" as const,
    instance: profile.instance,
    resources: profile.resources,
    isolation: "container" as const,
    availability: "available" as const,
    capabilities: ORB_RUNNER_CAPABILITIES,
  })),
  withTarget: (profile, endpoint) => ({ ...profile, endpoint }),
});
