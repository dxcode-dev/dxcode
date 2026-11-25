import type { Api, Model } from "@earendil-works/pi-ai";
import {
  getBuiltinModelDataGeneratedAt,
  getBuiltinModels,
} from "@earendil-works/pi-ai/providers/all";
import {
  liveCatalog,
  runtimeProviderModels,
} from "../../model-routing/live-catalog.js";

export const GITHUB_COPILOT_PROVIDER_ID = "github-copilot" as const;
export const GITHUB_COPILOT_API_ORIGIN =
  "https://api.githubcopilot.com" as const;

export type CopilotProtocol =
  | "openai-responses"
  | "openai-completions"
  | "anthropic-messages";

export interface CopilotCatalogModel {
  readonly id: string;
  readonly name: string;
  readonly protocol: CopilotProtocol;
  readonly endpoint: "/responses" | "/chat/completions" | "/v1/messages";
  readonly capabilities: {
    readonly contextWindow: number;
    readonly maxOutputTokens: number;
    readonly reasoning: boolean;
    readonly vision: boolean;
    readonly toolUse: true;
  };
  readonly cost: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly tiers?: ReadonlyArray<{
      readonly inputTokensAbove: number;
      readonly input: number;
      readonly output: number;
      readonly cacheRead: number;
      readonly cacheWrite: number;
    }>;
  };
  readonly compatibility: Readonly<Record<string, boolean>>;
  readonly thinkingLevelMap?: Readonly<Record<string, string | null>>;
}

type ModelInput = Omit<
  CopilotCatalogModel,
  "endpoint" | "capabilities" | "compatibility"
> & {
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly reasoning: boolean;
  readonly vision: boolean;
  readonly compatibility?: Readonly<Record<string, boolean>>;
};

const ENDPOINTS = {
  "anthropic-messages": "/v1/messages",
  "openai-completions": "/chat/completions",
  "openai-responses": "/responses",
} as const satisfies Record<CopilotProtocol, CopilotCatalogModel["endpoint"]>;

const isCopilotProtocol = (api: string): api is CopilotProtocol =>
  Object.hasOwn(ENDPOINTS, api);

/**
 * `supportsStrictMode` makes pi send `strict: false` on Responses tools, as it
 * does for OpenAI's own API. Without it pi leaves `strict` out, the Responses
 * API applies its strict default and requires every property, and GPT fills
 * each optional dx tool field with a placeholder (#1733).
 */
const model = (input: ModelInput): CopilotCatalogModel => ({
  id: input.id,
  name: input.name,
  protocol: input.protocol,
  endpoint: ENDPOINTS[input.protocol],
  capabilities: {
    contextWindow: input.contextWindow,
    maxOutputTokens: input.maxOutputTokens,
    reasoning: input.reasoning,
    vision: input.vision,
    toolUse: true,
  },
  cost: input.cost,
  compatibility:
    input.protocol === "openai-responses"
      ? { ...input.compatibility, supportsStrictMode: true }
      : (input.compatibility ?? {}),
  ...(input.thinkingLevelMap === undefined
    ? {}
    : { thinkingLevelMap: input.thinkingLevelMap }),
});

/**
 * Transcript transport features pi enables for Copilot. dx serves Copilot
 * with the system prompt and tools at the head of the request, the shape
 * proven end to end, so it keeps only model traits such as adaptive thinking.
 */
const TRANSPORT_COMPAT = new Set([
  "supportsMidConvoSystemMessages",
  "supportsMidConvoToolChanges",
  "supportsAdditionalTools",
]);

const fromPi = (entry: Model<Api>): CopilotCatalogModel[] => {
  if (!isCopilotProtocol(entry.api)) return [];
  const compatibility = Object.fromEntries(
    Object.entries(entry.compat ?? {}).filter(
      (pair): pair is [string, boolean] =>
        typeof pair[1] === "boolean" && !TRANSPORT_COMPAT.has(pair[0]),
    ),
  );
  return [
    model({
      id: entry.id,
      name: entry.name,
      protocol: entry.api,
      contextWindow: entry.contextWindow,
      maxOutputTokens: entry.maxTokens,
      reasoning: entry.reasoning,
      vision: entry.input.includes("image"),
      cost: entry.cost,
      compatibility,
      ...(entry.thinkingLevelMap === undefined
        ? {}
        : { thinkingLevelMap: entry.thinkingLevelMap }),
    }),
  ];
};

const cost = (
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite = 0,
) => ({ input, output, cacheRead, cacheWrite });
const legacyCompletionsCompat = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
};

/**
 * Models Copilot may still serve that pi's catalog no longer lists, kept from
 * the reviewed pi 0.84.3 snapshot. pi's entry wins when it lists the id, and
 * a connection only serves a model its Copilot entitlement enables.
 */
const RETAINED: ReadonlyArray<CopilotCatalogModel> = [
  model({
    id: "claude-opus-4.5",
    name: "Claude Opus 4.5 (latest)",
    protocol: "anthropic-messages",
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    reasoning: true,
    vision: true,
    cost: cost(5, 25, 0.5, 6.25),
  }),
  model({
    id: "claude-opus-4.6",
    name: "Claude Opus 4.6",
    protocol: "anthropic-messages",
    contextWindow: 1_000_000,
    maxOutputTokens: 32_000,
    reasoning: true,
    vision: true,
    cost: cost(5, 25, 0.5, 6.25),
    compatibility: { forceAdaptiveThinking: true },
    thinkingLevelMap: { max: "max" },
  }),
  model({
    id: "claude-sonnet-4",
    name: "Claude Sonnet 4 (latest)",
    protocol: "anthropic-messages",
    contextWindow: 216_000,
    maxOutputTokens: 16_000,
    reasoning: true,
    vision: true,
    cost: cost(3, 15, 0.3, 3.75),
    compatibility: { supportsEagerToolInputStreaming: false },
  }),
  model({
    id: "claude-sonnet-4.5",
    name: "Claude Sonnet 4.5 (latest)",
    protocol: "anthropic-messages",
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    reasoning: true,
    vision: true,
    cost: cost(3, 15, 0.3, 3.75),
    compatibility: { supportsEagerToolInputStreaming: false },
  }),
  model({
    id: "gemini-3.1-pro-preview",
    name: "Gemini 3.1 Pro Preview",
    protocol: "openai-completions",
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
    reasoning: true,
    vision: true,
    cost: cost(2, 12, 0.2),
    compatibility: legacyCompletionsCompat,
  }),
  model({
    id: "gpt-4.1",
    name: "GPT-4.1",
    protocol: "openai-completions",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    reasoning: false,
    vision: true,
    cost: cost(2, 8, 0.5),
    compatibility: legacyCompletionsCompat,
  }),
  model({
    id: "gpt-5.2",
    name: "GPT-5.2",
    protocol: "openai-responses",
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    reasoning: true,
    vision: true,
    cost: cost(1.75, 14, 0.175),
    compatibility: { supportsOpenAIGrammarTools: true },
    thinkingLevelMap: { off: null, minimal: "low", xhigh: "xhigh" },
  }),
  model({
    id: "gpt-5.2-codex",
    name: "GPT-5.2 Codex",
    protocol: "openai-responses",
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    reasoning: true,
    vision: true,
    cost: cost(1.75, 14, 0.175),
    compatibility: { supportsOpenAIGrammarTools: true },
    thinkingLevelMap: { off: null, minimal: "low", xhigh: "xhigh" },
  }),
];

const ENDPOINT_PROTOCOLS: ReadonlyArray<
  readonly [CopilotCatalogModel["endpoint"], CopilotProtocol]
> = [
  ["/v1/messages", "anthropic-messages"],
  ["/responses", "openai-responses"],
  ["/chat/completions", "openai-completions"],
];

/**
 * A Copilot model pi does not list, served on the protocol Copilot reported
 * for it. It borrowed its wire traits from the closest Copilot model of its
 * family; when Copilot does not serve it on that model's endpoint, it takes
 * the first endpoint Copilot named that dx speaks, in the order above.
 */
const fromObserved = (
  entry: Model<Api>,
  endpoints: ReadonlyArray<string> | undefined,
): CopilotCatalogModel[] => {
  if (
    endpoints === undefined ||
    (isCopilotProtocol(entry.api) && endpoints.includes(ENDPOINTS[entry.api]))
  )
    return fromPi(entry);
  const served = ENDPOINT_PROTOCOLS.find(([path]) => endpoints.includes(path));
  return served === undefined
    ? []
    : fromPi({
        ...entry,
        api: served[1],
        compat: {},
        thinkingLevelMap: undefined,
      } as Model<Api>);
};

let cached: { revision: string; models: ReadonlyArray<CopilotCatalogModel> } = {
  revision: "",
  models: [],
};

/**
 * Copilot models dx can serve: pi's pinned `github-copilot` catalog, the
 * models Copilot reported live for a connected account and models.dev lists
 * (live-catalog.ts), and the retained entries. A connection serves only the
 * models its own Copilot entitlement enables.
 */
export const githubCopilotCatalog = (): ReadonlyArray<CopilotCatalogModel> => {
  const live = liveCatalog();
  if (cached.revision === live.revision && cached.models.length > 0)
    return cached.models;
  const pinned = new Set(
    getBuiltinModels(GITHUB_COPILOT_PROVIDER_ID).map(({ id }) => id),
  );
  const endpoints = new Map(
    (live.discovered[GITHUB_COPILOT_PROVIDER_ID] ?? []).map(
      (model) => [model.id, model.endpoints] as const,
    ),
  );
  const models = runtimeProviderModels(GITHUB_COPILOT_PROVIDER_ID).flatMap(
    (entry) =>
      pinned.has(entry.id)
        ? fromPi(entry)
        : fromObserved(entry, endpoints.get(entry.id)),
  );
  const all = Object.freeze([
    ...models,
    ...RETAINED.filter(({ id }) => !models.some((model) => model.id === id)),
  ]);
  if (new Set(all.map(({ id }) => id)).size !== all.length)
    throw new Error("GitHub Copilot catalog contains duplicate model IDs");
  cached = { revision: live.revision, models: all };
  return all;
};

export const GITHUB_COPILOT_CATALOG_SOURCE = `pi:${
  getBuiltinModelDataGeneratedAt() ?? "unknown"
}`;

const catalogRevisionFor = (models: ReadonlyArray<CopilotCatalogModel>) => {
  let hash = 2_166_136_261;
  for (const character of JSON.stringify(models)) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return `${GITHUB_COPILOT_CATALOG_SOURCE}:${hash.toString(16).padStart(8, "0")}`;
};

let revision = { of: undefined as unknown, value: "" };

/** Changes whenever the catalog does, so entitlements read against it refresh. */
export const githubCopilotCatalogRevision = () => {
  const catalog = githubCopilotCatalog();
  if (revision.of !== catalog)
    revision = { of: catalog, value: catalogRevisionFor(catalog) };
  return revision.value;
};

export const findGitHubCopilotModel = (modelId: string) =>
  githubCopilotCatalog().find(({ id }) => id === modelId);
