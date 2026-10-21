import type { Api, Model } from "@earendil-works/pi-ai";
import {
  getBuiltinModelDataGeneratedAt,
  getBuiltinModels,
} from "@earendil-works/pi-ai/providers/all";

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
  compatibility: input.compatibility ?? {},
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

const PI_COPILOT_MODELS = getBuiltinModels(GITHUB_COPILOT_PROVIDER_ID).flatMap(
  fromPi,
);

/**
 * Copilot models dx can serve: pi's pinned `github-copilot` catalog plus the
 * retained entries. Upgrading pi adds new Copilot models here. Unknown IDs
 * fail closed.
 */
export const GITHUB_COPILOT_CATALOG: ReadonlyArray<CopilotCatalogModel> =
  Object.freeze([
    ...PI_COPILOT_MODELS,
    ...RETAINED.filter(
      ({ id }) => !PI_COPILOT_MODELS.some((model) => model.id === id),
    ),
  ]);

if (
  new Set(GITHUB_COPILOT_CATALOG.map(({ id }) => id)).size !==
  GITHUB_COPILOT_CATALOG.length
) {
  throw new Error("GitHub Copilot catalog contains duplicate model IDs");
}

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

export const GITHUB_COPILOT_CATALOG_REVISION = catalogRevisionFor(
  GITHUB_COPILOT_CATALOG,
);

export const findGitHubCopilotModel = (modelId: string) =>
  GITHUB_COPILOT_CATALOG.find(({ id }) => id === modelId);
