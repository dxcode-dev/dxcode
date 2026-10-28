import type { Schema } from "effect";
import type {
  ExecutionCapabilityId,
  ExecutionPauseResumePreserves,
} from "../plugins/execution.js";
import type {
  RunnerCapability,
  RunnerIsolation,
} from "../settings/runner-profile-fields.js";

/**
 * What every layer knows about one Orb provider, from one file
 * (`orb-providers/<provider>.ts`) listed once in `orb-providers/index.ts`.
 * Core and the API derive the provider ID set, the plugin registry entry,
 * the runner-profile schema, the size catalog, workspace policy, and pinned
 * targets from it; Core adds the provider's implementation in
 * `apps/core/src/execution/orb-providers.ts`. See
 * wiki/plugin-platform-direction.md "Adding an Orb provider".
 */
export interface OrbProviderDescriptor<
  Id extends string = string,
  ProfileSchema extends Schema.Top = Schema.Top,
> {
  /** The adapter, the plugin provider ID, and the stored pin: `[a-z0-9-]`. */
  readonly id: Id;
  /** Settings pages ("Cloudflare Containers"). */
  readonly displayName: string;
  /** The Orb picker ("Cloudflare"); defaults to `displayName`. */
  readonly shortName?: string;
  /** The execution capabilities dx implements on this provider. */
  readonly capabilities: ReadonlyArray<ExecutionCapabilityId>;
  /** What `execution.pause-resume` keeps; required when it is claimed. */
  readonly pauseResumePreserves?: ExecutionPauseResumePreserves;
  /**
   * Runs on another company's computers, so a workspace's "remote runners"
   * policy governs it.
   */
  readonly remote: boolean;
  /** The local development runtime; never offered deployed. */
  readonly development?: true;
  /**
   * How a deployment installs the provider on its own account: a secret
   * binding holding its key, or a binding whose presence installs it.
   * Absent: only a person's or workspace's connection runs it.
   */
  readonly deployment?:
    | { readonly secret: "E2B_API_KEY" }
    | { readonly binding: "ORB_CONTAINER" };
  /** The runner-profile configuration for this adapter. */
  readonly profile: ProfileSchema;
  /** Profile traits the catalog requires (isolation and capabilities). */
  readonly isolation: RunnerIsolation;
  readonly requiredCapabilities: ReadonlyArray<RunnerCapability>;
  readonly forbiddenCapabilities?: ReadonlyArray<RunnerCapability>;
  /** The provider's own sizes, which the catalog always lists. */
  readonly sizes: ReadonlyArray<ProfileSchema["Type"]>;
  /**
   * A size's profile with the target its Thread pinned from a connection
   * (an E2B template, a Cloudflare Orb Worker URL, a Freestyle snapshot).
   * Absent when the provider pins none.
   */
  readonly withTarget?: (
    profile: ProfileSchema["Type"],
    target: string,
  ) => ProfileSchema["Type"];
}

/** Types a provider's descriptor without widening its ID or profile. */
export const defineOrbProvider = <
  const Id extends string,
  ProfileSchema extends Schema.Top & {
    readonly Type: { readonly adapter: Id };
  },
>(
  descriptor: OrbProviderDescriptor<Id, ProfileSchema>,
) => descriptor;
