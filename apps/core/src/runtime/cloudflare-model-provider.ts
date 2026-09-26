import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import {
  type CloudflareAIBinding,
  cloudflareBindingProvider,
} from "@flue/runtime/cloudflare/workers-ai";

export const GLM_5_3_FLASH_MODEL_ID = "@cf/zai-org/glm-5.3-flash" as const;

const glm53Flash: Model<Api> = {
  id: GLM_5_3_FLASH_MODEL_ID,
  name: "GLM 5.3 Flash",
  api: "cloudflare-ai-binding",
  provider: "cloudflare",
  baseUrl: "",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 },
  contextWindow: 1_048_576,
  maxTokens: 0,
};

/** Adds current dx-reviewed metadata without changing Flue's binding transport. */
export const createDxCloudflareModelProvider = (
  binding: CloudflareAIBinding,
): Provider => {
  const provider = cloudflareBindingProvider({ binding });
  const models = Object.freeze([
    ...provider.getModels().filter(({ id }) => id !== GLM_5_3_FLASH_MODEL_ID),
    glm53Flash,
  ]);
  return Object.assign(provider, { getModels: () => models });
};
