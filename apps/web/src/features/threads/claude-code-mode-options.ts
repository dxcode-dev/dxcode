import type { ChoicesData } from "@dx/api";
import { claudePlanBlockedUntil } from "@dx/domain";

type ClaudePlanChoice = ChoicesData["claudePlans"][number];

/**
 * The enabled Claude plans a new Claude Code Thread can be bound to, in
 * routing order, and the one picked. None picked leaves it to dx when the
 * Thread is created ("Auto").
 */
export const claudePlanPick = (
  choices: ChoicesData | undefined,
  picked: string | undefined,
) => {
  const plans = (choices?.claudePlans ?? []).filter(({ enabled }) => enabled);
  const current = plans.find(({ connectionId }) => connectionId === picked);
  return { plans, current };
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
