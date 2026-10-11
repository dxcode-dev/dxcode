import type { ChoicesData } from "@dx/api";
import {
  CLAUDE_CODE_DEFAULT_MODEL,
  type ClaudeCodeEffort,
  isClaudeCodeModel,
} from "@dx/domain";
import { modelDisplayName } from "../../shared/model-display-name.js";
import type { ModeDialClaudeCode } from "../../shared/ui/mode-dial-plate.js";

const EFFORT_LABELS: Readonly<Record<ClaudeCodeEffort, string>> = {
  low: "Low Effort",
  medium: "Medium Effort",
  high: "High Effort",
  xhigh: "Extra High Effort",
  max: "Max Effort",
};

export const claudeCodeEffortLabel = (effort: ClaudeCodeEffort) =>
  EFFORT_LABELS[effort];

/** Claude Code models the owner's connected plan serves, in catalog order. */
export const claudeCodeModels = (choices: ChoicesData | undefined) =>
  (choices?.models ?? []).filter(({ canonical }) =>
    isClaudeCodeModel(canonical),
  );

/** The model Claude Code would run: the pinned one, else the default. */
export const currentClaudeCodeModel = (
  choices: ChoicesData | undefined,
  model: string | undefined,
) => {
  const models = claudeCodeModels(choices);
  const selected = model !== undefined && isClaudeCodeModel(model);
  return {
    models,
    selected,
    current:
      (selected
        ? models.find(({ canonical }) => canonical === model)
        : undefined) ??
      models.find(({ canonical }) => canonical === CLAUDE_CODE_DEFAULT_MODEL) ??
      models[0],
  };
};

/** "Claude Haiku 5.5" without the family name, as the dial shows it. */
const claudeCodeShortName = (name: string) =>
  modelDisplayName(name).replace(/^Claude /, "");

/** The dial's Claude Code lamp and display, once a plan is connected. */
export const claudeCodeDial = (
  choices: ChoicesData | undefined,
  model: string | undefined,
  effort: ClaudeCodeEffort,
): ModeDialClaudeCode | undefined => {
  const { selected, current } = currentClaudeCodeModel(choices, model);
  if (current === undefined) return undefined;
  return {
    selected,
    model: claudeCodeShortName(current.name).toUpperCase(),
    effort: effort === "xhigh" ? "X-HIGH" : effort.toUpperCase(),
  };
};
