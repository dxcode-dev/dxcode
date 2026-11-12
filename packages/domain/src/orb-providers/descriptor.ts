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
 * A provider's public list prices in US dollars, with the page they come
 * from and the day they were read: usage rates that price any size from its
 * CPU, memory, and disk, or a fixed hourly price per size ID. Only a
 * person's or workspace's own connection pays these; a deployment's account
 * shows its own `costLabel` instead.
 */
export type OrbProviderPricing = {
  /** CPU is billed only while in use, so a size's price is a maximum. */
  readonly cpuBilledWhenActive?: true;
  readonly source: string;
  readonly checkedOn: string;
} & (
  | {
      readonly usdPerVcpuHour: number;
      readonly usdPerGibMemoryHour: number;
      readonly usdPerGbDiskHour: number;
    }
  | { readonly usdPerSizeHour: Readonly<Record<string, number>> }
);

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
   * The personal experimental feature that offers this provider while it is
   * in beta (#1924): until a person turns it on, the provider is not listed,
   * connectable, or pinned by their new Threads. Threads that already pinned
   * it keep running. Absent: offered to everyone.
   */
  readonly betaFeature?: string;
  /**
   * Only a deployment's own account runs it, and only under the
   * deployment's own name (`DeploymentOrbs.displayName`, such as a hosted offer):
   * people and workspaces never connect their own, and it is never offered
   * under the provider's name.
   */
  readonly deploymentOnly?: true;
  /**
   * How a deployment installs the provider on its own account: a secret
   * binding holding its key, or a binding whose presence installs it.
   * Absent: only a person's or workspace's connection runs it.
   */
  readonly deployment?:
    | { readonly secret: "E2B_API_KEY" }
    /**
     * `prepared`: the deployment's account is prepared at runtime like a
     * connection (its connector saves the Orb image there), once for every
     * person's Threads.
     */
    | { readonly secret: "BOAT_API_KEY"; readonly prepared: true }
    | {
        readonly secret: "LIZARD_API_KEY";
        readonly prepared: true;
        /**
         * Credential fields the deployment sets beside its key, each from
         * a binding: the account's project, and where it runs.
         */
        readonly settings: Readonly<
          Record<string, "LIZARD_PROJECT_ID" | "LIZARD_REGION">
        >;
      }
    | { readonly binding: "ORB_CONTAINER" };
  /** The runner-profile configuration for this adapter. */
  readonly profile: ProfileSchema;
  /** Profile traits the catalog requires (isolation and capabilities). */
  readonly isolation: RunnerIsolation;
  readonly requiredCapabilities: ReadonlyArray<RunnerCapability>;
  readonly forbiddenCapabilities?: ReadonlyArray<RunnerCapability>;
  /** List prices; absent when dx does not know what the provider charges. */
  readonly pricing?: OrbProviderPricing;
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
