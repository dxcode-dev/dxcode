import { CLAUDE_CODE_MODELS, CLAUDE_CODE_PROVIDER_ID } from "@dx/domain";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  getBuiltinModelDataGeneratedAt,
  getBuiltinProviders,
} from "@earendil-works/pi-ai/providers/all";
import { Schema } from "effect";
import { DX_PROVIDER_ID, dxCatalogModels } from "./deployment-models.js";
import { builtinModelsWithSuccessors } from "./newer-models.js";
import { piCatalogProviderId } from "./providers.js";
import { RETIRED_WORKERS_AI_MODELS } from "./retired-models.js";

export const MODEL_CATALOG_SOURCE = "flue-2.3.0-pi-1.1.0" as const;

/**
 * Workers AI models dx knows ahead of pi-ai's catalog, with dx's reviewed
 * metadata. Empty while pi-ai's list is current.
 */
const currentWorkersAiModels: ReadonlyArray<Model<Api>> = [];

/**
 * Claude Code models. The `claude-code` api is not a wire format: the Claude
 * Code CLI in the Thread workspace owns these calls on the owner's plan.
 */
export const CLAUDE_CODE_API = "claude-code" as const;

const claudeCodeModels: ReadonlyArray<Model<Api>> = CLAUDE_CODE_MODELS.map(
  ({ id, name }) => ({
    id,
    name,
    api: CLAUDE_CODE_API,
    provider: CLAUDE_CODE_PROVIDER_ID,
    baseUrl: "",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  }),
);

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

/**
 * dx's display names for catalog entries whose upstream name is cased or
 * punctuated unlike the rest of the catalog, keyed by canonical id. Every
 * settings page reads a model's name from this catalog, so fix a name here.
 */
const MODEL_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  "cloudflare/@cf/zai-org/glm-4.7-flash": "GLM 4.7 Flash",
  "cloudflare/@cf/zai-org/glm-5.2": "GLM 5.2",
  "cloudflare/@cf/zai-org/glm-5.3": "GLM 5.3",
};

const withDisplayName = (providerId: string, model: Model<Api>): Model<Api> => {
  const name = MODEL_DISPLAY_NAMES[`${providerId}/${model.id}`];
  return name === undefined || name === model.name ? model : { ...model, name };
};

export const catalogProviderModels = (providerId: string) => {
  if (providerId === CLAUDE_CODE_PROVIDER_ID) return [...claudeCodeModels];
  if (providerId === DX_PROVIDER_ID) return [...dxCatalogModels()];
  const models = builtinModelsWithSuccessors(piCatalogProviderId(providerId));
  return (
    providerId === "cloudflare"
      ? [
          ...models,
          ...currentWorkersAiModels.filter(
            ({ id }) => !models.some((model) => model.id === id),
          ),
        ].filter(({ id }) => !RETIRED_WORKERS_AI_MODELS.has(id))
      : models
  ).map((model) => withDisplayName(providerId, model));
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

export * from "./providers.js";
