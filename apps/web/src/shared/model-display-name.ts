import type { ChoicesData } from "@dx/api";

const MODEL_WORDS: Readonly<Record<string, string>> = {
  gpt: "GPT",
  claude: "Claude",
  terra: "Terra",
  sol: "Sol",
  astra: "Astra",
  fable: "Fable",
  luna: "Luna",
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
};
export function modelDisplayName(name: string): string {
  const short = name.split("/").at(-1) ?? name;
  if (short.includes(" ")) return short;
  return short
    .replace(/(\d)-(\d)/g, "$1.$2")
    .split("-")
    .map((word) => MODEL_WORDS[word.toLowerCase()] ?? word)
    .join(" ")
    .replace(/^GPT (\d)/, "GPT-$1");
}

/**
 * A model's catalog name from the routing choices: a served model's, else
 * the name of one the deployment names but does not serve now (a dx model
 * whose upstream is off), else a mode's. Undefined when none names it.
 */
export const choicesModelName = (
  choices: ChoicesData | undefined,
  canonical: string,
): string | undefined =>
  choices?.models.find((model) => model.canonical === canonical)?.name ??
  choices?.unservedModels?.find((model) => model.canonical === canonical)
    ?.name ??
  choices?.modes.find(({ config }) => config.model === canonical)?.modelName;
