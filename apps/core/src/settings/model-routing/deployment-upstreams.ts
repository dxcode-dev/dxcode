import type { Api, Model } from "@earendil-works/pi-ai";
import type { ProviderFieldSpec } from "./providers.js";

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
   * The model's own wire API and endpoint, when they differ from the
   * preset's: OpenRouter serves some models over Anthropic's format.
   */
  readonly api?: DeploymentUpstream["api"];
  readonly baseUrl?: string;
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
    | "azure-openai-responses"
    | "mistral-conversations"
    | "google-generative-ai"
    | "bedrock-converse-stream"
    | "cloudflare-ai-binding";
  readonly baseUrl: string;
  /**
   * The Settings provider (providers.ts) this upstream connects as, when it
   * is one: its fields move the endpoint, its check tests the key, and
   * Google and Bedrock calls run in the credential coordinator with it.
   */
  readonly providerId?: string;
  /** What the admin fills in besides the key, such as a Bedrock region. */
  readonly fields?: ReadonlyArray<ProviderFieldSpec>;
  /** Runs on a binding the deployment already has, so it takes no key. */
  readonly keyless?: boolean;
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
