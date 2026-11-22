/**
 * Workers AI models Cloudflare retired on 2026-11-20: a request to one fails
 * with 410 Gone (error 5028). See
 * https://developers.cloudflare.com/changelog/post/2026-11-05-planned-model-deprecations/.
 * The model catalog leaves them out, so no one picks one.
 */
export const RETIRED_WORKERS_AI_MODELS: ReadonlySet<string> = new Set([
  "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
  "@cf/nvidia/nemotron-3-120b-a12b",
  "@cf/deepseek-ai/deepseek-v4-pro-0813",
  "@cf/deepseek-ai/deepseek-v4-flash-0731",
  "@cf/qwen/qwq-32b",
  "@cf/qwen/qwen3-30b-a3b-fp8",
  "@cf/moonshotai/kimi-k2.6",
  "@cf/moonshotai/kimi-k2.7-code",
  "@cf/zai-org/glm-5.2",
  "@cf/zai-org/glm-5.3-flash",
  "@cf/meta-llama/llama-2-7b-chat-hf-lora",
  "@cf/google/gemma-2b-it-lora",
  "@cf/google/gemma-7b-it-lora",
  "@cf/meta/llama-3.1-8b-instruct-fp8",
  "@cf/meta/llama-3.2-1b-instruct",
  "@cf/meta/llama-3.2-3b-instruct",
]);

/**
 * dx's own Workers AI defaults that were retired, each with the model that
 * replaced it. A Thread, mode, or Space saved to the old default runs on its
 * replacement. Other retired models keep Cloudflare's own error: moving a
 * person's chosen model to a different price is theirs to decide.
 */
const REPLACED_DEFAULTS: Readonly<Record<string, string>> = {
  "cloudflare/@cf/zai-org/glm-5.3-flash":
    "cloudflare/@cf/zai-org/glm-4.7-flash",
};

/**
 * The Workers AI model that replaced a retired one dx used as a default
 * (an upstream id, without the `cloudflare/` prefix); undefined otherwise.
 */
export const workersAiReplacement = (upstreamId: string): string | undefined =>
  REPLACED_DEFAULTS[`cloudflare/${upstreamId}`]?.slice("cloudflare/".length);

/** `model`, or the default that replaced it when it is a retired default. */
export const currentWorkersAiModel = <Model extends string>(
  model: Model,
): Model => (REPLACED_DEFAULTS[model] as Model | undefined) ?? model;
