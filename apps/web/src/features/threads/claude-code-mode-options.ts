import type { ChoicesData } from "@dx/api";
import {
  CLAUDE_CODE_DEFAULT_MODEL,
  type ClaudeCodeEffort,
  claudePlanBlockedUntil,
  claudePlanWindowName,
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

type ClaudePlanChoice = ChoicesData["claudePlans"][number];

/**
 * The enabled Claude plans a new Claude Code Thread can be bound to, in
 * routing order, and the one it would take: the one picked, else the first.
 */
export const claudePlanPick = (
  choices: ChoicesData | undefined,
  picked: string | undefined,
) => {
  const plans = (choices?.claudePlans ?? []).filter(({ enabled }) => enabled);
  return {
    plans,
    current:
      plans.find(({ connectionId }) => connectionId === picked) ?? plans[0],
  };
};

const clock = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  hour: "numeric",
  minute: "2-digit",
});

/**
 * A plan as the composer lists it, from the limits Claude Code last
 * reported: used up until when, else its fullest window and when that
 * resets.
 */
export const claudePlanLabel = (
  plan: ClaudePlanChoice,
  model: string,
  nowSeconds: number,
) => {
  const usedUpUntil = claudePlanBlockedUntil(
    plan.usage,
    plan.allowExtraUsage,
    nowSeconds,
    model.slice(model.indexOf("/") + 1),
  );
  if (usedUpUntil !== undefined)
    return `${plan.name} · used up until ${clock.format(usedUpUntil * 1000)}`;
  const fullest = (plan.usage?.windows ?? [])
    .filter(({ resetsAt }) => resetsAt > nowSeconds)
    .sort((a, b) => b.utilization - a.utilization)[0];
  if (fullest === undefined)
    return plan.usage === undefined
      ? `${plan.name} · no limits reported yet`
      : plan.name;
  return `${plan.name} · ${claudePlanWindowName(fullest.id)} ${Math.round(
    Math.min(fullest.utilization, 1) * 100,
  )}%, resets ${clock.format(fullest.resetsAt * 1000)}`;
};
