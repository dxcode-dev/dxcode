import {
  type ClaudePlanUsage,
  claudePlanBlockedUntil,
  claudePlanWindowFamily,
} from "./claude-code.js";

/**
 * The automatic pick of the Claude Pro/Max plan a new Claude Code Thread is
 * bound to for life, when no person or agent names one. It runs once, at
 * creation; nothing ever moves a Thread to another plan.
 */

/**
 * The personal experimental flag that turns the pick on, read for the new
 * Thread's owner (whose plans are picked). Off, a Thread that names no plan
 * is created as before: refused when its owner has several enabled plans.
 */
export const CLAUDE_PLAN_AUTO_PICK_FEATURE = "claude-plan-auto-pick";

/** A plan as the pick sees it: its last-known limits and running Threads. */
export interface ClaudePlanCandidate {
  readonly connectionId: string;
  readonly name: string;
  readonly allowExtraUsage: boolean;
  readonly usage?: ClaudePlanUsage;
  /** Threads on the plan working now or bound in the last few minutes. */
  readonly load?: number;
}

export type ClaudeAutoPlan =
  | {
      readonly kind: "picked";
      readonly connectionId: string;
      readonly name: string;
      /** Why, in a few words for the composer's picker. */
      readonly summary: string;
      /** Why, with the readings it went by. */
      readonly reason: string;
    }
  | {
      readonly kind: "used-up";
      readonly connectionId: string;
      readonly name: string;
      /** Epoch seconds: the soonest reset among the used-up plans. */
      readonly resetsAt: number;
    };

const HOUR = 3_600;
const FIVE_HOURS = 5 * HOUR;
const WEEK = 7 * 24 * HOUR;

/**
 * About how much of a 5-hour window one running Thread uses per hour: six
 * Threads take a window to about 95% by its reset.
 */
export const CLAUDE_PLAN_THREAD_HOURLY_USE = 0.95 / 5 / 6;

/** Threads one plan sustains, since a Thread runs on into the next window. */
export const CLAUDE_PLAN_MAX_LOAD = 6;

/** A plan's weekly use may run this far ahead of a straight line to 90%. */
const WEEKLY_PACE_TARGET = 0.9;
const WEEKLY_PACE_SLACK = 0.05;

const percent = (fraction: number) => `${Math.round(fraction * 100)}%`;

const duration = (seconds: number) => {
  const minutes = Math.max(1, Math.round(seconds / 60));
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes} min`;
  if (hours >= 48) return `${Math.round(hours / 24)} days`;
  return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
};

interface Scored {
  readonly plan: ClaudePlanCandidate;
  readonly index: number;
  readonly load: number;
  /** The open 5-hour window, if one is open now. */
  readonly window?: { readonly used: number; readonly resetsAt: number };
  readonly projected: number;
  readonly fits: boolean;
  readonly weekly: { readonly used: number; readonly pace: number };
  readonly onPace: boolean;
}

const score = (
  plan: ClaudePlanCandidate,
  index: number,
  model: string,
  now: number,
): Scored => {
  const windows = (plan.usage?.windows ?? []).filter(
    ({ resetsAt }) => resetsAt > now,
  );
  const load = Math.max(0, plan.load ?? 0);
  const five = windows.find(({ id }) => id === "five_hour");
  const used5h = five?.utilization ?? 0;
  const hoursLeft = ((five?.resetsAt ?? now + FIVE_HOURS) - now) / HOUR;
  const projected =
    used5h + hoursLeft * CLAUDE_PLAN_THREAD_HOURLY_USE * (load + 1);
  // The account-wide weekly window and the model's own, whichever is fuller.
  const weekly = windows
    .filter(({ id }) => {
      if (id === "five_hour") return false;
      const family = claudePlanWindowFamily(id);
      return family === undefined || model.includes(family);
    })
    .map(({ utilization, resetsAt }) => {
      const elapsed = Math.min(1, Math.max(0, 1 - (resetsAt - now) / WEEK));
      return { used: utilization, pace: WEEKLY_PACE_TARGET * elapsed };
    })
    .sort((a, b) => b.used - b.pace - (a.used - a.pace))[0] ?? {
    used: 0,
    pace: 0,
  };
  return {
    plan,
    index,
    load,
    ...(five === undefined || five.utilization <= 0
      ? {}
      : { window: { used: five.utilization, resetsAt: five.resetsAt } }),
    projected,
    fits: projected <= 1 && load + 1 <= CLAUDE_PLAN_MAX_LOAD,
    weekly,
    onPace: weekly.used <= weekly.pace + WEEKLY_PACE_SLACK,
  };
};

/** How far behind its weekly pace a plan is; larger is more room. */
const weeklyRoom = ({ weekly }: Scored) => weekly.pace - weekly.used;

const preferred = (a: Scored, b: Scored) => {
  // Use it or lose it: an open window that resets soonest first.
  if (a.window !== undefined && b.window !== undefined)
    if (a.window.resetsAt !== b.window.resetsAt)
      return a.window.resetsAt - b.window.resetsAt;
  if (a.window !== undefined && b.window === undefined) return -1;
  if (a.window === undefined && b.window !== undefined) return 1;
  if (weeklyRoom(a) !== weeklyRoom(b)) return weeklyRoom(b) - weeklyRoom(a);
  if (a.load !== b.load) return a.load - b.load;
  return a.index - b.index;
};

/** The fallback when no plan fits: on pace first, then the most 5-hour room. */
const leastFull = (a: Scored, b: Scored) => {
  if (a.onPace !== b.onPace) return a.onPace ? -1 : 1;
  if (a.projected !== b.projected) return a.projected - b.projected;
  return a.index - b.index;
};

const describe = (scored: Scored, now: number, lead: string) => {
  const five =
    scored.window === undefined
      ? "5-hour limit unused"
      : `5-hour limit ${percent(scored.window.used)}, resets in ${duration(
          scored.window.resetsAt - now,
        )}`;
  const weekly = `weekly ${percent(scored.weekly.used)} (pace ${percent(
    scored.weekly.pace,
  )})`;
  const running =
    scored.load === 1 ? "1 Thread running" : `${scored.load} Threads running`;
  return `${lead}: ${five}; ${weekly}; ${running}.`;
};

/**
 * The plan a new Claude Code Thread on `model` (a Claude model id such as
 * `claude-opus-5-5`) takes when none is named, from the enabled plans in
 * routing order; undefined with none. A plan used up for the model is never
 * picked: when all are, the one that resets first, so creation is refused
 * with its reset.
 */
export const pickClaudePlan = (
  plans: ReadonlyArray<ClaudePlanCandidate>,
  model: string,
  now: number,
): ClaudeAutoPlan | undefined => {
  const open: Scored[] = [];
  let usedUp: { plan: ClaudePlanCandidate; until: number } | undefined;
  plans.forEach((plan, index) => {
    const until = claudePlanBlockedUntil(
      plan.usage,
      plan.allowExtraUsage,
      now,
      model,
    );
    if (until === undefined) open.push(score(plan, index, model, now));
    else if (usedUp === undefined || until < usedUp.until)
      usedUp = { plan, until };
  });
  const healthy = open
    .filter(({ fits, onPace }) => fits && onPace)
    .sort(preferred)[0];
  const picked = healthy ?? [...open].sort(leastFull)[0];
  if (picked !== undefined) {
    const summary =
      healthy === undefined
        ? "every plan is near its limit"
        : picked.window !== undefined
          ? "resets soonest with room left"
          : "most weekly room";
    return {
      kind: "picked",
      connectionId: picked.plan.connectionId,
      name: picked.plan.name,
      summary,
      reason: describe(
        picked,
        now,
        `${summary[0]?.toUpperCase()}${summary.slice(1)}`,
      ),
    };
  }
  const soonest = usedUp as
    | { plan: ClaudePlanCandidate; until: number }
    | undefined;
  return soonest === undefined
    ? undefined
    : {
        kind: "used-up",
        connectionId: soonest.plan.connectionId,
        name: soonest.plan.name,
        resetsAt: soonest.until,
      };
};
