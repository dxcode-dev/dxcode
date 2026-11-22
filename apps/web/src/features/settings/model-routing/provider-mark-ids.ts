/** Providers that have a mark in provider-marks.tsx (dx draws its wordmark). */
const PROVIDER_MARK_IDS: ReadonlySet<string> = new Set([
  "amazon-bedrock",
  "dx",
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
