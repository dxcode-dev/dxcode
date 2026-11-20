import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import {
  type CloudflareAIBinding,
  cloudflareBindingProvider,
} from "@flue/runtime/cloudflare/workers-ai";

/**
 * The Workers AI model dev, preview, and staging run on: the cheapest one
 * that drives dx's tools reliably (Cloudflare retired GLM 5.3 Flash on
 * 2026-11-20). Text only.
 */
export const GLM_4_7_FLASH_MODEL_ID = "@cf/zai-org/glm-4.7-flash" as const;

const glm47Flash: Model<Api> = {
  id: GLM_4_7_FLASH_MODEL_ID,
  name: "GLM 4.7 Flash",
  api: "cloudflare-ai-binding",
  provider: "cloudflare",
  baseUrl: "",
  reasoning: true,
  input: ["text"],
  cost: { input: 0.06, output: 0.4, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 131_072,
  maxTokens: 0,
};

/**
 * GLM 4.7 Flash thinks unless its chat template turns thinking off, and it
 * ignores `reasoning_effort`: at "low" a three-word title took 4 to 25 s and
 * hundreds of output tokens. A request that asks no effort runs without
 * thinking, as Spaces' own calls to the model do.
 */
const withoutUnaskedThinking = (
  binding: CloudflareAIBinding,
): CloudflareAIBinding => ({
  run: (model, payload, options) =>
    binding.run(
      model,
      model === GLM_4_7_FLASH_MODEL_ID &&
        payload.reasoning_effort === undefined &&
        payload.chat_template_kwargs === undefined
        ? { ...payload, chat_template_kwargs: { enable_thinking: false } }
        : payload,
      options,
    ),
});

/** Adds current dx-reviewed metadata without changing Flue's binding transport. */
export const createDxCloudflareModelProvider = (
  binding: CloudflareAIBinding,
): Provider => {
  const provider = cloudflareBindingProvider({
    binding: withoutUnaskedThinking(binding),
  });
  const models = Object.freeze([
    ...provider.getModels().filter(({ id }) => id !== GLM_4_7_FLASH_MODEL_ID),
    glm47Flash,
  ]);
  return Object.assign(provider, { getModels: () => models });
};
