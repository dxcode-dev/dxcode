/**
 * Who makes a model, for its logo and its provider group: the canonical
 * id's prefix ("anthropic/claude-opus-5-5"), or, for a model served
 * through a gateway or a custom endpoint, its name ("openrouter/google/
 * gemini-4" is Google's).
 */
const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  // Models the installation provides: dx, whoever serves them upstream.
  dx: "dx",
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  xai: "xAI",
  deepseek: "DeepSeek",
  moonshotai: "Moonshot",
  zai: "Z.ai",
  nvidia: "NVIDIA",
  meta: "Meta",
  qwen: "Qwen",
  mistral: "Mistral",
};

const BY_NAME: ReadonlyArray<readonly [RegExp, string]> = [
  [/claude|opus|sonnet|haiku|fable/i, "anthropic"],
  [/\bgpt|\bo[1-9]\b|codex/i, "openai"],
  [/gemini|gemma/i, "google"],
  [/grok/i, "xai"],
  [/deepseek/i, "deepseek"],
  [/kimi|moonshot/i, "moonshotai"],
  [/\bglm|z-?ai/i, "zai"],
  [/nemotron|nvidia/i, "nvidia"],
  [/llama|muse/i, "meta"],
  [/qwen/i, "qwen"],
  [/mistral|devstral|codestral/i, "mistral"],
];

export const modelProvider = (
  canonical: string,
  name = "",
): { readonly id: string; readonly name: string } => {
  const [prefix = "", ...rest] = canonical.split("/");
  if (prefix === "claude-code") return { id: "anthropic", name: "Anthropic" };
  const known = PROVIDER_NAMES[prefix];
  if (known !== undefined) return { id: prefix, name: known };
  const text = `${rest.join("/")} ${name}`;
  for (const [pattern, id] of BY_NAME)
    if (pattern.test(text)) return { id, name: PROVIDER_NAMES[id] ?? id };
  return { id: prefix, name: "Other" };
};
