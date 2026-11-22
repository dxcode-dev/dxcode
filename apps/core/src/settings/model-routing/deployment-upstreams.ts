import type { Api, Model } from "@earendil-works/pi-ai";

/**
 * Upstreams: the inference services an installation can pay for and offer
 * as dx models (deployment-models.ts). Only the shapes are public: a
 * deployment keeps its presets with its registration
 * (deployment-models-registration.ts). A preset fixes what admins never
 * type: the wire API, base URL, request traits, each model's limits, and
 * the upstream's own list price. Admins choose which preset upstreams to
 * enable, their keys, and which models to offer under which dx alias.
 */

/** What an upstream model can do, and what the upstream charges for it. */
export interface UpstreamModel {
  /** The default dx name when the admin gives none. Never the upstream's brand. */
  readonly name: string;
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly reasoning: boolean;
  readonly vision: boolean;
  readonly thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
  /** Request traits for this model, over the preset's. */
  readonly compat?: Model<Api>["compat"];
  /**
   * The upstream's list price per 1M tokens in the preset's currency. dx
   * charges it converted to USD, plus the admin's markup. Cache rates the
   * upstream does not list are charged at the input rate.
   */
  readonly upstreamPrice: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead?: number;
    readonly cacheWrite?: number;
  };
}

export interface DeploymentUpstream {
  /** The preset key the deployment stores. */
  readonly id: string;
  /** Internal only: logs and the deployment's own admin tools. */
  readonly label: string;
  /**
   * The wire API. `cloudflare-ai-binding` runs on the deployment's own
   * Workers AI binding inside the credential coordinator; the others go
   * through the coordinator's proxy with the upstream key.
   */
  readonly api:
    | "openai-completions"
    | "openai-responses"
    | "anthropic-messages"
    | "cloudflare-ai-binding";
  readonly baseUrl: string;
  /** Runs on a binding the deployment already has, so it takes no key. */
  readonly keyless?: boolean;
  /** How `checkUpstream` tests a key: a GET relative to the base URL. */
  readonly probe?: {
    readonly path: string;
    readonly headers: (key: string) => Readonly<Record<string, string>>;
  };
  readonly compat: Model<Api>["compat"];
  /** The currency of the models' upstreamPrice: USD, or one with an admin fx rate. */
  readonly currency: string;
  /** Words scrubbed from upstream error text before a person sees it. */
  readonly redact: ReadonlyArray<string>;
  readonly models: Readonly<Record<string, UpstreamModel>>;
  /**
   * Models the upstream retired: a request to one fails. Each names the
   * listed model that replaces it, or null when none does.
   */
  readonly retired?: Readonly<Record<string, string | null>>;
}
