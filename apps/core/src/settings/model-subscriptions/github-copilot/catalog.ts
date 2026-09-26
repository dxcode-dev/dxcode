export const GITHUB_COPILOT_PROVIDER_ID = "github-copilot" as const;
export const GITHUB_COPILOT_CATALOG_SOURCE = "pi-0.84.3" as const;
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

const endpointFor = (protocol: CopilotProtocol) => {
  switch (protocol) {
    case "anthropic-messages":
      return "/v1/messages" as const;
    case "openai-completions":
      return "/chat/completions" as const;
    case "openai-responses":
      return "/responses" as const;
  }
};

const model = (input: ModelInput): CopilotCatalogModel => ({
  id: input.id,
  name: input.name,
  protocol: input.protocol,
  endpoint: endpointFor(input.protocol),
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

const anthropic = (input: Omit<ModelInput, "protocol">) =>
  model({ ...input, protocol: "anthropic-messages" });
const completions = (input: Omit<ModelInput, "protocol">) =>
  model({ ...input, protocol: "openai-completions" });
const responses = (input: Omit<ModelInput, "protocol">) =>
  model({ ...input, protocol: "openai-responses" });
const cost = (
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite = 0,
) => ({ input, output, cacheRead, cacheWrite });

/** Reviewed copy of Pi v0.84.3's Copilot catalog. Unknown IDs fail closed. */
export const GITHUB_COPILOT_CATALOG: ReadonlyArray<CopilotCatalogModel> =
  Object.freeze([
    anthropic({
      id: "claude-haiku-4.5",
      name: "Claude Haiku 4.5 (latest)",
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      reasoning: true,
      vision: true,
      cost: cost(1, 5, 0.1, 1.25),
      compatibility: { supportsEagerToolInputStreaming: false },
    }),
    anthropic({
      id: "claude-opus-4.5",
      name: "Claude Opus 4.5 (latest)",
      contextWindow: 200_000,
      maxOutputTokens: 32_000,
      reasoning: true,
      vision: true,
      cost: cost(5, 25, 0.5, 6.25),
    }),
    anthropic({
      id: "claude-opus-4.6",
      name: "Claude Opus 4.6",
      contextWindow: 1_000_000,
      maxOutputTokens: 32_000,
      reasoning: true,
      vision: true,
      cost: cost(5, 25, 0.5, 6.25),
      compatibility: { forceAdaptiveThinking: true },
      thinkingLevelMap: { max: "max" },
    }),
    anthropic({
      id: "claude-opus-4.7",
      name: "Claude Opus 4.7",
      contextWindow: 1_000_000,
      maxOutputTokens: 32_000,
      reasoning: true,
      vision: true,
      cost: cost(5, 25, 0.5, 6.25),
      compatibility: {
        forceAdaptiveThinking: true,
        supportsTemperature: false,
      },
      thinkingLevelMap: { minimal: "low", xhigh: "xhigh", max: "max" },
    }),
    anthropic({
      id: "claude-opus-4.8",
      name: "Claude Opus 4.8",
      contextWindow: 1_000_000,
      maxOutputTokens: 64_000,
      reasoning: true,
      vision: true,
      cost: cost(5, 25, 0.5, 6.25),
      compatibility: {
        forceAdaptiveThinking: true,
        supportsTemperature: false,
      },
      thinkingLevelMap: { minimal: "low", xhigh: "xhigh", max: "max" },
    }),
    anthropic({
      id: "claude-opus-5",
      name: "Claude Opus 5",
      contextWindow: 1_000_000,
      maxOutputTokens: 64_000,
      reasoning: true,
      vision: true,
      cost: cost(5, 25, 0.5, 6.25),
      compatibility: {
        forceAdaptiveThinking: true,
        supportsTemperature: false,
      },
      thinkingLevelMap: { minimal: "low", xhigh: "xhigh", max: "max" },
    }),
    anthropic({
      id: "claude-sonnet-4",
      name: "Claude Sonnet 4 (latest)",
      contextWindow: 216_000,
      maxOutputTokens: 16_000,
      reasoning: true,
      vision: true,
      cost: cost(3, 15, 0.3, 3.75),
      compatibility: { supportsEagerToolInputStreaming: false },
    }),
    anthropic({
      id: "claude-sonnet-4.5",
      name: "Claude Sonnet 4.5 (latest)",
      contextWindow: 200_000,
      maxOutputTokens: 32_000,
      reasoning: true,
      vision: true,
      cost: cost(3, 15, 0.3, 3.75),
      compatibility: { supportsEagerToolInputStreaming: false },
    }),
    anthropic({
      id: "claude-sonnet-4.6",
      name: "Claude Sonnet 4.6",
      contextWindow: 1_000_000,
      maxOutputTokens: 32_000,
      reasoning: true,
      vision: true,
      cost: cost(3, 15, 0.3, 3.75),
      compatibility: { forceAdaptiveThinking: true },
      thinkingLevelMap: { minimal: "low", max: "max" },
    }),
    anthropic({
      id: "claude-sonnet-5",
      name: "Claude Sonnet 5",
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      reasoning: true,
      vision: true,
      cost: cost(2, 10, 0.2, 2.5),
      compatibility: { forceAdaptiveThinking: true },
      thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    }),
    completions({
      id: "claude-fable-5",
      name: "Claude Fable 5",
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      reasoning: true,
      vision: true,
      cost: cost(10, 50, 1, 12.5),
      compatibility: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
      },
      thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
    }),
    anthropic({
      id: "claude-fable-5.1",
      name: "Claude Fable 5.1",
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      reasoning: true,
      vision: true,
      cost: cost(10, 50, 0.25, 12.5),
      compatibility: {
        forceAdaptiveThinking: true,
        supportsTemperature: false,
      },
      thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
    }),
    completions({
      id: "gemini-3.1-pro-preview",
      name: "Gemini 3.1 Pro Preview",
      contextWindow: 1_000_000,
      maxOutputTokens: 64_000,
      reasoning: true,
      vision: true,
      cost: cost(2, 12, 0.2),
      compatibility: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
      },
    }),
    completions({
      id: "gemini-3.5-flash",
      name: "Gemini 3.5 Flash",
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      reasoning: true,
      vision: true,
      cost: cost(1.5, 9, 0.15),
      compatibility: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
      },
    }),
    completions({
      id: "gemini-3.6-flash",
      name: "Gemini 3.6 Flash",
      contextWindow: 1_000_000,
      maxOutputTokens: 64_000,
      reasoning: true,
      vision: true,
      cost: cost(1.5, 7.5, 0.15),
      compatibility: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
      },
    }),
    completions({
      id: "gemini-3.8-flash",
      name: "Gemini 3.8 Flash",
      contextWindow: 1_000_000,
      maxOutputTokens: 64_000,
      reasoning: true,
      vision: true,
      cost: cost(0.75, 3.75, 0.075),
      compatibility: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
      },
    }),
    completions({
      id: "gemini-3.7-flash",
      name: "Gemini 3.7 Flash",
      contextWindow: 1_000_000,
      maxOutputTokens: 64_000,
      reasoning: true,
      vision: true,
      cost: cost(0.75, 3.75, 0.075),
      compatibility: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
      },
    }),
    completions({
      id: "gpt-4.1",
      name: "GPT-4.1",
      contextWindow: 128_000,
      maxOutputTokens: 16_384,
      reasoning: false,
      vision: true,
      cost: cost(2, 8, 0.5),
      compatibility: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
      },
    }),
    completions({
      id: "kimi-k2.7-code",
      name: "Kimi K2.7 Code",
      contextWindow: 256_000,
      maxOutputTokens: 32_000,
      reasoning: true,
      vision: true,
      cost: cost(0.95, 4, 0.19),
      compatibility: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
      },
    }),
    completions({
      id: "kimi-k3",
      name: "Kimi K3",
      contextWindow: 1_048_576,
      maxOutputTokens: 131_072,
      reasoning: true,
      vision: true,
      cost: cost(3, 15, 0.3),
      compatibility: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
      },
    }),
    responses({
      id: "gpt-5-mini",
      name: "GPT-5 Mini",
      contextWindow: 264_000,
      maxOutputTokens: 64_000,
      reasoning: true,
      vision: true,
      cost: cost(0.25, 2, 0.025),
      compatibility: { supportsOpenAIGrammarTools: true },
      thinkingLevelMap: {
        off: null,
        minimal: "low",
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: null,
        max: null,
      },
    }),
    responses({
      id: "gpt-5.2",
      name: "GPT-5.2",
      contextWindow: 400_000,
      maxOutputTokens: 128_000,
      reasoning: true,
      vision: true,
      cost: cost(1.75, 14, 0.175),
      compatibility: { supportsOpenAIGrammarTools: true },
      thinkingLevelMap: { off: null, minimal: "low", xhigh: "xhigh" },
    }),
    responses({
      id: "gpt-5.2-codex",
      name: "GPT-5.2 Codex",
      contextWindow: 400_000,
      maxOutputTokens: 128_000,
      reasoning: true,
      vision: true,
      cost: cost(1.75, 14, 0.175),
      compatibility: { supportsOpenAIGrammarTools: true },
      thinkingLevelMap: { off: null, minimal: "low", xhigh: "xhigh" },
    }),
    responses({
      id: "gpt-5.3-codex",
      name: "GPT-5.3 Codex",
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      reasoning: true,
      vision: true,
      cost: cost(1.75, 14, 0.175),
      compatibility: { supportsOpenAIGrammarTools: true },
      thinkingLevelMap: {
        off: null,
        minimal: "low",
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: null,
      },
    }),
    responses({
      id: "gpt-5.4",
      name: "GPT-5.4",
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      reasoning: true,
      vision: true,
      cost: cost(2.5, 15, 0.25),
      compatibility: { supportsOpenAIGrammarTools: true },
      thinkingLevelMap: {
        off: null,
        minimal: "low",
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: null,
      },
    }),
    responses({
      id: "gpt-5.4-mini",
      name: "GPT-5.4 mini",
      contextWindow: 400_000,
      maxOutputTokens: 128_000,
      reasoning: true,
      vision: true,
      cost: cost(0.75, 4.5, 0.075),
      compatibility: { supportsOpenAIGrammarTools: true },
      thinkingLevelMap: {
        off: null,
        minimal: "low",
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: null,
      },
    }),
    responses({
      id: "gpt-5.4-nano",
      name: "GPT-5.4 nano",
      contextWindow: 400_000,
      maxOutputTokens: 128_000,
      reasoning: true,
      vision: true,
      cost: cost(0.2, 1.25, 0.02),
      compatibility: { supportsOpenAIGrammarTools: true },
      thinkingLevelMap: { off: null, minimal: "low", xhigh: "xhigh" },
    }),
    responses({
      id: "gpt-5.5",
      name: "GPT-5.5",
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      reasoning: true,
      vision: true,
      cost: cost(5, 30, 0.5),
      compatibility: { supportsOpenAIGrammarTools: true },
      thinkingLevelMap: {
        off: null,
        minimal: "low",
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: null,
      },
    }),
    responses({
      id: "gpt-5.6-luna",
      name: "GPT-5.6 Luna",
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
      reasoning: true,
      vision: true,
      cost: cost(0.2, 1.2, 0.02),
      compatibility: { supportsOpenAIGrammarTools: true },
      thinkingLevelMap: {
        off: null,
        minimal: "low",
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: "max",
      },
    }),
    responses({
      id: "gpt-5.6-sol",
      name: "GPT-5.6 Sol",
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
      reasoning: true,
      vision: true,
      cost: cost(2.5, 15, 0.25, 3.125),
      compatibility: { supportsOpenAIGrammarTools: true },
      thinkingLevelMap: {
        off: null,
        minimal: "low",
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: "max",
      },
    }),
    responses({
      id: "gpt-5.6-terra",
      name: "GPT-5.6 Terra",
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
      reasoning: true,
      vision: true,
      cost: cost(2, 12, 0.2),
      compatibility: { supportsOpenAIGrammarTools: true },
      thinkingLevelMap: {
        off: null,
        minimal: "low",
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: "max",
      },
    }),
    completions({
      id: "gpt-6-astra",
      name: "GPT-6 Astra",
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
      reasoning: true,
      vision: true,
      cost: {
        input: 10,
        output: 50,
        cacheRead: 1,
        cacheWrite: 12.5,
        tiers: [
          {
            inputTokensAbove: 272_000,
            input: 20,
            output: 75,
            cacheRead: 2,
            cacheWrite: 25,
          },
        ],
      },
      compatibility: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
      },
      thinkingLevelMap: {
        off: null,
        minimal: "low",
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: "max",
      },
    }),
    responses({
      id: "grok-4.5",
      name: "Grok 4.5",
      contextWindow: 500_000,
      maxOutputTokens: 128_000,
      reasoning: true,
      vision: true,
      cost: cost(2, 6, 0.5),
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: null,
        max: null,
      },
    }),
    responses({
      id: "grok-4.6",
      name: "Grok 4.6",
      contextWindow: 500_000,
      maxOutputTokens: 128_000,
      reasoning: true,
      vision: true,
      cost: cost(2, 6, 0.5),
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: null,
      },
    }),
    responses({
      id: "mai-code-1-flash-picker",
      name: "MAI-Code-1-Flash",
      contextWindow: 256_000,
      maxOutputTokens: 128_000,
      reasoning: true,
      vision: false,
      cost: cost(0.75, 4.5, 0.075),
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: null,
        max: null,
      },
    }),
    responses({
      id: "mai-code-1.1-flash",
      name: "MAI-Code-1.1-Flash",
      contextWindow: 256_000,
      maxOutputTokens: 128_000,
      reasoning: true,
      vision: true,
      cost: cost(0.2, 1.2, 0.02),
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: null,
        max: null,
      },
    }),
  ]);

if (
  new Set(GITHUB_COPILOT_CATALOG.map(({ id }) => id)).size !==
  GITHUB_COPILOT_CATALOG.length
) {
  throw new Error("GitHub Copilot catalog contains duplicate model IDs");
}

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
