/** Catalog providers that have a brand mark in provider-marks.tsx. */
const PROVIDER_MARK_IDS: ReadonlySet<string> = new Set([
  "amazon-bedrock",
  "anthropic",
  "cloudflare-ai-gateway",
  "fireworks",
  "google",
  "azure-openai-responses",
  "nvidia",
  "openai",
  "openrouter",
  "xai",
  "deepseek",
  "moonshotai",
  "zai",
]);

export const hasProviderMark = (providerId: string): boolean =>
  PROVIDER_MARK_IDS.has(providerId);
