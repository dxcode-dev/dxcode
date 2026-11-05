import type { ChoicesData } from "@dx/api";
import { pickClaudePlan } from "@dx/domain";

/**
 * The composer's Auto plan label, loaded only when the person's automatic
 * plan pick is on, so the pick's policy stays out of the page's first load.
 */

type ClaudePlanChoice = ChoicesData["claudePlans"][number];

/**
 * The picker's Auto choice: the plan Core would bind a new Thread on
 * `model` to now, from the same readings and running Threads, and why.
 */
export const claudeAutoPlanLabel = (
  plans: ReadonlyArray<ClaudePlanChoice>,
  model: string,
  nowSeconds: number,
): { readonly label: string; readonly reason?: string } => {
  const auto = pickClaudePlan(
    plans,
    model.slice(model.indexOf("/") + 1),
    nowSeconds,
  );
  if (auto === undefined) return { label: "Auto" };
  if (auto.kind === "used-up")
    return {
      label: `Auto · every plan used up until ${clock.format(auto.resetsAt * 1000)}`,
    };
  return {
    label: `Auto · ${auto.name}, ${auto.summary}`,
    reason: auto.reason,
  };
};

const clock = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  hour: "numeric",
  minute: "2-digit",
});
