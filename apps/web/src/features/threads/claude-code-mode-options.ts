import type { ChoicesData } from "@dx/api";
import {
  CLAUDE_CODE_DEFAULT_MODEL,
  type ClaudeCodeEffort,
  claudePlanBlockedUntil,
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

const SHORT_EFFORT_LABELS: Readonly<Record<ClaudeCodeEffort, string>> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "X-High",
  max: "Max",
};

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

/**
 * The composer chip's words for a Claude Code pick, "Opus 5.5 High": the
 * Claude icon and color already say Claude Code.
 */
export const claudeCodeChipLabel = (name: string, effort: ClaudeCodeEffort) =>
  `${claudeCodeShortName(name)} ${SHORT_EFFORT_LABELS[effort]}`;

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

type ClaudePlanChoice = ChoicesData["claudePlans"][number];

/**
 * The enabled Claude plans a new Claude Code Thread can be bound to, in
 * routing order, and the one it takes: the one picked, else the first. With
 * the person's automatic plan pick on (`auto`), none picked leaves it to dx
 * when the Thread is created ("Auto").
 */
export const claudePlanPick = (
  choices: ChoicesData | undefined,
  picked: string | undefined,
) => {
  const plans = (choices?.claudePlans ?? []).filter(({ enabled }) => enabled);
  const auto = choices?.claudeAutoPick === true;
  const named = plans.find(({ connectionId }) => connectionId === picked);
  return { plans, auto, current: auto ? named : (named ?? plans[0]) };
};

/** A plan's short name in the composer: "Plan 2", by routing order. */
export const claudePlanNumber = (
  plans: ReadonlyArray<ClaudePlanChoice>,
  connectionId: string,
) =>
  `Plan ${plans.findIndex((plan) => plan.connectionId === connectionId) + 1}`;

/**
 * A plan as the composer's plan list names it: its number, and "used up"
 * when Claude Code last reported it out of room for `model`. The limits
 * popover names each numbered plan and shows its limits.
 */
export const claudePlanLabel = (
  plans: ReadonlyArray<ClaudePlanChoice>,
  plan: ClaudePlanChoice,
  model: string,
  nowSeconds: number,
) => {
  const number = claudePlanNumber(plans, plan.connectionId);
  return claudePlanBlockedUntil(
    plan.usage,
    plan.allowExtraUsage,
    nowSeconds,
    model.slice(model.indexOf("/") + 1),
  ) === undefined
    ? number
    : `${number} · used up`;
};
