import type { ChoicesData } from "@dx/api";
import { pickClaudePlan } from "@dx/domain";

/**
 * The composer's note on what Auto would pick, loaded only when the
 * person's automatic plan pick is on, so the pick's policy stays out of the
 * page's first load.
 */

type ClaudePlanChoice = ChoicesData["claudePlans"][number];

/**
 * The plan Core would bind a new Thread on `model` to now, from the same
 * readings and running Threads, and why; undefined with no plan to pick.
 */
export const claudeAutoPlanNote = (
  plans: ReadonlyArray<ClaudePlanChoice>,
  model: string,
  nowSeconds: number,
  /** The plan's short name, such as "Plan 2". */
  nameOf: (connectionId: string) => string,
): string | undefined => {
  const auto = pickClaudePlan(
    plans,
    model.slice(model.indexOf("/") + 1),
    nowSeconds,
  );
  if (auto === undefined) return undefined;
  if (auto.kind === "used-up")
    return `Every plan is used up until ${clock.format(auto.resetsAt * 1000)}.`;
  return `Auto picks ${nameOf(auto.connectionId)}. ${auto.reason}`;
};

const clock = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  hour: "numeric",
  minute: "2-digit",
});
