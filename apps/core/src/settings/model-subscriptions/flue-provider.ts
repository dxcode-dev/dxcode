import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import {
  type CloudflareAIBinding,
  cloudflareBindingProvider,
} from "@flue/runtime/cloudflare/workers-ai";
import { GITHUB_COPILOT_CATALOG } from "./github-copilot/catalog.js";

// Runtime provider id for subscription-backed models; Phase 2 folds the
// Copilot connection into the canonical `github-copilot` provider shape.
const DX_SUBSCRIPTION_MODEL_PROVIDER_ID = "dx-subscription";

const modelForFlue = (
  model: (typeof GITHUB_COPILOT_CATALOG)[number],
): Model<Api> => ({
  id: model.id,
  name: model.name,
  api: model.protocol,
  provider: DX_SUBSCRIPTION_MODEL_PROVIDER_ID,
  baseUrl: "",
  reasoning: model.capabilities.reasoning,
  input: model.capabilities.vision ? ["text", "image"] : ["text"],
  cost: {
    input: model.cost.input,
    output: model.cost.output,
    cacheRead: model.cost.cacheRead,
    cacheWrite: model.cost.cacheWrite,
    ...(model.cost.tiers === undefined
      ? {}
      : { tiers: model.cost.tiers.map((tier) => ({ ...tier })) }),
  },
  contextWindow: model.capabilities.contextWindow,
  maxTokens: model.capabilities.maxOutputTokens,
  ...(model.thinkingLevelMap === undefined
    ? {}
    : { thinkingLevelMap: model.thinkingLevelMap }),
  ...(Object.keys(model.compatibility).length === 0
    ? {}
    : { compat: model.compatibility as Model<Api>["compat"] }),
});

const MODELS = Object.freeze(GITHUB_COPILOT_CATALOG.map(modelForFlue));

/** Keeps Flue as the only protocol, tool, history, and streaming runtime. */
export const createDxSubscriptionFlueProvider = (
  binding: CloudflareAIBinding,
): Provider => {
  const transport = cloudflareBindingProvider({ binding, gateway: false });
  return {
    ...transport,
    id: DX_SUBSCRIPTION_MODEL_PROVIDER_ID,
    name: "Personal subscriptions",
    getModels: () => MODELS,
  };
};
