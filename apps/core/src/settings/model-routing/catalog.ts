import type { Api, Model } from "@earendil-works/pi-ai";
import {
  getBuiltinModelDataGeneratedAt,
  getBuiltinModels,
  getBuiltinProviders,
} from "@earendil-works/pi-ai/providers/all";
import { Schema } from "effect";

export const MODEL_CATALOG_SOURCE = "flue-2.0.7-pi-0.85.1" as const;

/**
 * Canonical dx provider id → pi-ai catalog provider id. dx calls the
 * Workers AI deployment catalog `cloudflare`; every other provider keeps
 * its pi-ai id.
 */
const PI_PROVIDER_IDS: Record<string, string> = {
  cloudflare: "cloudflare-workers-ai",
};

export const piCatalogProviderId = (providerId: string): string =>
  PI_PROVIDER_IDS[providerId] ?? providerId;

type BuiltinProviderId = Parameters<typeof getBuiltinModels>[0];

const currentWorkersAiModels: ReadonlyArray<Model<Api>> = [
  {
    id: "@cf/zai-org/glm-5.3-flash",
    name: "GLM 5.3 Flash",
    api: "openai-completions",
    provider: "cloudflare",
    baseUrl: "https://api.cloudflare.com/client/v4",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 },
    contextWindow: 1_048_576,
    maxTokens: 16_384,
  },
];

/**
 * The pi-ai catalog entry for a canonical `providerId/modelId` pair, or
 * undefined when the catalog does not know it. Capabilities (context window,
 * output limit, reasoning, vision) and cost come only from here — users
 * never enter them.
 */
export const findCatalogModel = (providerId: string, modelId: string) =>
  catalogProviderModels(providerId).find(({ id }) => id === modelId);

export const catalogModelExists = (canonical: string): boolean => {
  const slash = canonical.indexOf("/");
  if (slash <= 0) return false;
  return (
    findCatalogModel(canonical.slice(0, slash), canonical.slice(slash + 1)) !==
    undefined
  );
};

export const catalogProviderModels = (providerId: string) => {
  const models = getBuiltinModels(
    piCatalogProviderId(providerId) as BuiltinProviderId,
  );
  return providerId === "cloudflare"
    ? [
        ...models,
        ...currentWorkersAiModels.filter(
          ({ id }) => !models.some((model) => model.id === id),
        ),
      ]
    : models;
};

export const catalogProviderIds = (): ReadonlyArray<string> =>
  getBuiltinProviders();

export const modelCatalogGeneratedAt = (() => {
  const timestamp = getBuiltinModelDataGeneratedAt();
  return timestamp === undefined
    ? undefined
    : Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)(
        new Date(timestamp).toISOString(),
      );
})();

// Supported provider picker ---------------------------------------------------

/**
 * Wire families: `proxy` adapters accept a coordinator `fetch` (the DO swaps
 * credentials and forwards); `in-do` adapters refuse custom fetch and run
 * inside the coordinator DO (Google genai SDK, Bedrock AWS SDK);
 * `subscription` is the OAuth Copilot flow; `binding` is the deployment
 * Workers AI binding.
 */
export type ProviderTransport = "proxy" | "in-do" | "subscription" | "binding";

/** pi-ai `api` values routed through the coordinator header-swap proxy. */
export const PROXY_APIS: ReadonlySet<string> = new Set([
  "openai-completions",
  "openai-responses",
  "azure-openai-responses",
  "anthropic-messages",
  "mistral-conversations",
]);

/** pi-ai `api` values whose adapters run inside the coordinator DO. */
export const IN_DO_APIS: ReadonlySet<string> = new Set([
  "google-generative-ai",
  "bedrock-converse-stream",
]);

export interface ProviderFieldSpec {
  readonly key: string;
  readonly label: string;
  readonly required: boolean;
  readonly secret: boolean;
  readonly placeholder?: string;
  readonly description?: string;
}

export interface SupportedProvider {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly connectionKind: "provider" | "subscription" | "deployment";
  readonly transport: ProviderTransport;
  readonly fields: ReadonlyArray<ProviderFieldSpec>;
}

const provider = (
  spec: Omit<SupportedProvider, "connectionKind" | "transport" | "fields"> & {
    readonly connectionKind?: SupportedProvider["connectionKind"];
    readonly transport?: ProviderTransport;
    readonly fields?: ReadonlyArray<ProviderFieldSpec>;
  },
): SupportedProvider => ({
  connectionKind: "provider",
  transport: "proxy",
  fields: [],
  ...spec,
});

/**
 * The 0.1.0 provider picker (decision 15). Official key providers plus the
 * Copilot subscription and the deployment Workers AI binding. Vertex,
 * `openai-codex` OAuth and pi-ai internal/token-plan providers stay hidden.
 */
export const SUPPORTED_PROVIDERS: ReadonlyArray<SupportedProvider> = [
  provider({
    id: "github-copilot",
    name: "GitHub Copilot",
    description: "Copilot subscription (device sign-in).",
    connectionKind: "subscription",
    transport: "subscription",
  }),
  provider({
    id: "openai",
    name: "OpenAI",
    description: "OpenAI platform API.",
  }),
  provider({
    id: "anthropic",
    name: "Anthropic",
    description: "Anthropic API.",
  }),
  provider({
    id: "google",
    name: "Google",
    description: "Gemini API (AI Studio key).",
    transport: "in-do",
  }),
  provider({ id: "xai", name: "xAI", description: "xAI API (Grok)." }),
  provider({
    id: "azure-openai-responses",
    name: "Azure OpenAI",
    description: "Azure OpenAI Responses deployments.",
    fields: [
      {
        key: "resourceName",
        label: "Resource name",
        required: true,
        secret: false,
        placeholder: "my-resource",
        description:
          "Requests go to https://<resource>.openai.azure.com. Set a base URL in Advanced to override.",
      },
    ],
  }),
  provider({
    id: "amazon-bedrock",
    name: "Amazon Bedrock",
    description: "Bedrock runtime with a bearer API key.",
    transport: "in-do",
    fields: [
      {
        key: "region",
        label: "Region",
        required: true,
        secret: false,
        placeholder: "us-east-1",
        description: "AWS region for the Bedrock runtime endpoint.",
      },
    ],
  }),
  provider({
    id: "cloudflare-ai-gateway",
    name: "Cloudflare AI Gateway",
    description: "Route providers through an AI Gateway.",
    fields: [
      {
        key: "accountId",
        label: "Account ID",
        required: true,
        secret: false,
      },
      {
        key: "gatewayId",
        label: "Gateway ID",
        required: true,
        secret: false,
      },
    ],
  }),
  provider({ id: "groq", name: "Groq", description: "Groq API." }),
  provider({
    id: "openrouter",
    name: "OpenRouter",
    description: "OpenRouter aggregator API.",
  }),
  provider({
    id: "deepseek",
    name: "DeepSeek",
    description: "DeepSeek API.",
  }),
  provider({
    id: "together",
    name: "Together",
    description: "Together AI API.",
  }),
  provider({
    id: "fireworks",
    name: "Fireworks",
    description: "Fireworks AI API.",
  }),
  provider({
    id: "cerebras",
    name: "Cerebras",
    description: "Cerebras inference API.",
  }),
  provider({
    id: "moonshotai",
    name: "Moonshot AI",
    description: "Moonshot AI API (Kimi).",
  }),
  provider({
    id: "minimax",
    name: "MiniMax",
    description: "MiniMax API.",
  }),
  provider({ id: "zai", name: "Z.AI", description: "Z.AI API (GLM)." }),
  provider({
    id: "nvidia",
    name: "NVIDIA",
    description: "NVIDIA NIM API.",
  }),
  provider({
    id: "huggingface",
    name: "Hugging Face",
    description: "Hugging Face inference API.",
  }),
  provider({
    id: "mistral",
    name: "Mistral",
    description: "Mistral API.",
  }),
  provider({
    id: "cloudflare",
    name: "Workers AI (deployment)",
    description:
      "This deployment's Workers AI binding; shown when the runtime has one.",
    connectionKind: "deployment",
    transport: "binding",
  }),
];

/**
 * Providers presented by the picker. API-key providers need an explicit
 * deployment opt-in, while the personal Copilot flow stays available.
 */
export const pickerProviders = (
  deploymentProviders: string | undefined,
  workersAiAvailable: boolean,
): ReadonlyArray<SupportedProvider> => {
  const enabled = new Set(
    (deploymentProviders ?? "")
      .split(",")
      .map((providerId) => providerId.trim())
      .filter(Boolean),
  );
  return SUPPORTED_PROVIDERS.filter((provider) => {
    if (provider.connectionKind === "subscription") return true;
    if (provider.connectionKind === "deployment") return workersAiAvailable;
    return enabled.has(provider.id);
  });
};

export const supportedProvider = (id: string): SupportedProvider | undefined =>
  SUPPORTED_PROVIDERS.find((candidate) => candidate.id === id);
