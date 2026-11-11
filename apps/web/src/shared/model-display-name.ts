import type { ClaudeCodeEffort } from "@dx/domain";

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

const SHORT_EFFORT_LABELS: Readonly<Record<ClaudeCodeEffort, string>> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "X-High",
  max: "Max",
};

/** "Claude Haiku 5.5" without the family name, as the dial shows it. */
export const claudeCodeShortName = (name: string) =>
  modelDisplayName(name).replace(/^Claude /, "");

/**
 * The words of a Claude Code chip, "Opus 5.5 High": the Claude icon and
 * color already say Claude Code. The New Thread composer's mode chip and
 * Create Space's Agent row both show it.
 */
export const claudeCodeChipLabel = (name: string, effort: ClaudeCodeEffort) =>
  `${claudeCodeShortName(name)} ${SHORT_EFFORT_LABELS[effort]}`;
