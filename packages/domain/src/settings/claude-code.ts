import { Schema } from "effect";
import type { ThinkingLevel } from "./model-routing.js";

/**
 * Claude Code mode: a Thread whose agent loop is the Claude Code CLI running
 * in the Thread's workspace on the owner's Claude Pro/Max plan. A personal
 * model connection with this provider id stores the `claude setup-token`
 * OAuth token; a Thread pins `claude-code/<model>` with an effort.
 */
export const CLAUDE_CODE_PROVIDER_ID = "claude-code";

export interface ClaudeCodeModel {
  readonly id: string;
  readonly name: string;
}

/** Models a Claude Pro/Max plan serves to Claude Code, newest first. */
export const CLAUDE_CODE_MODELS: ReadonlyArray<ClaudeCodeModel> = [
  { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5" },
  { id: "claude-fable-5-1", name: "Claude Fable 5.1" },
  { id: "claude-opus-5", name: "Claude Opus 5" },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
];

export const CLAUDE_CODE_DEFAULT_MODEL = `${CLAUDE_CODE_PROVIDER_ID}/claude-opus-5-5`;

/** The `--effort` levels Claude Code accepts. */
export const CLAUDE_CODE_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies ReadonlyArray<ThinkingLevel>;

export type ClaudeCodeEffort = (typeof CLAUDE_CODE_EFFORTS)[number];

export const CLAUDE_CODE_DEFAULT_EFFORT: ClaudeCodeEffort = "high";

export const isClaudeCodeModel = (canonical: string): boolean =>
  canonical.startsWith(`${CLAUDE_CODE_PROVIDER_ID}/`);

/** The effort Claude Code runs at for a Thread's thinking level. */
export const claudeCodeEffort = (thinking: ThinkingLevel): ClaudeCodeEffort =>
  thinking === "off" || thinking === "minimal"
    ? "low"
    : (thinking as ClaudeCodeEffort);

/**
 * A usage window of a Claude plan, as Anthropic's rate-limit headers name
 * it: the 5-hour session window, the weekly window, and weekly per-model
 * windows.
 */
export const ClaudePlanWindowId = Schema.Literals([
  "five_hour",
  "seven_day",
  "seven_day_opus",
  "seven_day_sonnet",
  "seven_day_overage_included",
]);

export type ClaudePlanWindowId = typeof ClaudePlanWindowId.Type;

export const ClaudePlanLimitStatus = Schema.Literals([
  "allowed",
  "allowed_warning",
  "rejected",
]);

export type ClaudePlanLimitStatus = typeof ClaudePlanLimitStatus.Type;

/** Unix epoch seconds. */
const EpochSeconds = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const ClaudePlanWindow = Schema.Struct({
  id: ClaudePlanWindowId,
  /** Fraction of the window used; above 1 when usage ran past its cap. */
  utilization: Schema.Finite.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(100),
  ),
  resetsAt: EpochSeconds,
});

export type ClaudePlanWindow = typeof ClaudePlanWindow.Type;

/**
 * What one Anthropic response said about a Claude plan's limits. `status`
 * and `limit` describe the window that limits now; `extraUsage` is the
 * account's paid extra usage, which Anthropic bills once a window is used up
 * when the account has it turned on.
 */
export const ClaudePlanReading = Schema.Struct({
  status: ClaudePlanLimitStatus,
  limit: Schema.optional(
    Schema.Struct({ id: ClaudePlanWindowId, resetsAt: EpochSeconds }),
  ),
  windows: Schema.Array(ClaudePlanWindow).check(Schema.isMaxLength(5)),
  extraUsage: Schema.Struct({
    status: Schema.optional(ClaudePlanLimitStatus),
    resetsAt: Schema.optional(EpochSeconds),
    inUse: Schema.Boolean,
    /** Anthropic's `overage-disabled-reason`, such as `org_level_disabled`. */
    disabledReason: Schema.optional(
      Schema.String.check(Schema.isMaxLength(64)),
    ),
  }),
});

export type ClaudePlanReading = typeof ClaudePlanReading.Type;

/** The latest reading for a plan, with when dx observed it. */
export const ClaudePlanUsage = Schema.Struct({
  ...ClaudePlanReading.fields,
  observedAt: EpochSeconds,
});

export type ClaudePlanUsage = typeof ClaudePlanUsage.Type;

/**
 * Disabled reasons that mean extra usage is on but its credits or spend cap
 * are used up, as the Claude Code CLI reads them. Every other reason means
 * the account cannot use extra usage at all.
 */
const EXTRA_USAGE_USED_UP_REASONS = new Set([
  "out_of_credits",
  "org_level_disabled_until",
  "org_spend_cap_reached",
]);

/**
 * The account's paid extra usage as Anthropic last reported it: in use, on,
 * on but used up for now, or off, which no dx choice can change.
 */
export type ClaudePlanExtraUsage = "in-use" | "on" | "used-up" | "off";

export const claudePlanExtraUsage = (
  reading: ClaudePlanReading | undefined,
): ClaudePlanExtraUsage | undefined => {
  const extraUsage = reading?.extraUsage;
  if (extraUsage === undefined) return undefined;
  if (extraUsage.inUse) return "in-use";
  if (extraUsage.status === undefined) return undefined;
  if (extraUsage.status !== "rejected") return "on";
  return extraUsage.disabledReason !== undefined &&
    EXTRA_USAGE_USED_UP_REASONS.has(extraUsage.disabledReason)
    ? "used-up"
    : "off";
};

/** Why the account has no extra usage, from Anthropic's disabled reason. */
export const claudePlanExtraUsageOffReason = (
  reason: string | undefined,
): string => {
  switch (reason) {
    case "org_level_disabled":
    case "org_service_level_disabled":
      return "Your Claude organization turned extra usage off.";
    case "member_level_disabled":
      return "Your Claude organization turned extra usage off for your account.";
    case "seat_tier_level_disabled":
    case "seat_tier_zero_credit_limit":
    case "member_zero_credit_limit":
    case "group_zero_credit_limit":
      return "Your Claude plan does not include extra usage.";
    case "overage_not_provisioned":
    case "no_limits_configured":
      return "Extra usage is not set up on your Claude account.";
    default:
      return "Your Claude account has no extra usage.";
  }
};

/** Whether the response that carried the reading drew on extra usage. */
export const claudePlanUsesExtraUsage = (reading: ClaudePlanReading) =>
  reading.extraUsage.inUse ||
  (reading.status === "rejected" &&
    (reading.extraUsage.status === "allowed" ||
      reading.extraUsage.status === "allowed_warning"));

/**
 * Adds a reading to the plan's usage. A window the reading leaves out keeps
 * its last value until it resets. A reading older than the stored one, such
 * as a run's last reading sent again on a later step, changes nothing.
 */
export const mergeClaudePlanUsage = (
  previous: ClaudePlanUsage | undefined,
  reading: ClaudePlanReading,
  observedAt: number,
): ClaudePlanUsage => {
  if (previous !== undefined && previous.observedAt > observedAt)
    return previous;
  const ids = new Set(reading.windows.map(({ id }) => id));
  const kept = (previous?.windows ?? []).filter(
    (window) => !ids.has(window.id) && window.resetsAt > observedAt,
  );
  const order = ClaudePlanWindowId.literals;
  return {
    ...reading,
    windows: [...reading.windows, ...kept].sort(
      (a, b) => order.indexOf(a.id) - order.indexOf(b.id),
    ),
    observedAt,
  };
};

/** How long a used-up plan stays blocked when Anthropic named no reset. */
const UNKNOWN_RESET_SECONDS = 3_600;

/**
 * The model family a per-model weekly window limits; account-wide windows
 * have none. Claude Code calls the overage-included bucket the Fable limit.
 */
const WINDOW_FAMILIES: Partial<Record<ClaudePlanWindowId, string>> = {
  seven_day_opus: "opus",
  seven_day_sonnet: "sonnet",
  seven_day_overage_included: "fable",
};

export const claudePlanWindowFamily = (id: ClaudePlanWindowId) =>
  WINDOW_FAMILIES[id];

/**
 * Whether a window limits a model: account-wide windows limit every model, a
 * per-model window only its family. Without a model, only account-wide
 * windows count.
 */
const windowLimits = (id: ClaudePlanWindowId, model: string | undefined) => {
  const family = WINDOW_FAMILIES[id];
  return family === undefined || (model?.includes(family) ?? false);
};

/**
 * When Claude Code cannot fall back to paid extra usage, because dx keeps it
 * off or the account has it off, the time (epoch seconds) until which the
 * plan is used up for `model` (a Claude model id such as `claude-opus-5-5`;
 * omitted, the account-wide windows), or undefined while it has room.
 */
export const claudePlanBlockedUntil = (
  usage: ClaudePlanUsage | undefined,
  allowExtraUsage: boolean,
  now: number,
  model?: string,
): number | undefined => {
  if (usage === undefined) return undefined;
  if (allowExtraUsage && claudePlanExtraUsage(usage) !== "off")
    return undefined;
  if (usage.status !== "rejected" && !claudePlanUsesExtraUsage(usage))
    return undefined;
  const usedUp = Math.max(
    0,
    ...usage.windows
      .filter(
        ({ id, utilization }) => utilization >= 1 && windowLimits(id, model),
      )
      .map(({ resetsAt }) => resetsAt),
  );
  // A per-model window for another family: only a used-up account-wide
  // window still limits this model.
  if (usage.limit !== undefined && !windowLimits(usage.limit.id, model))
    return usedUp > now ? usedUp : undefined;
  const until = usage.limit?.resetsAt ?? usedUp;
  const resetsAt = until > 0 ? until : usage.observedAt + UNKNOWN_RESET_SECONDS;
  return resetsAt > now ? resetsAt : undefined;
};

/** The names Claude Code itself gives the plan's windows. */
const WINDOW_NAMES: Record<ClaudePlanWindowId, string> = {
  five_hour: "5-hour limit",
  seven_day: "Weekly limit",
  seven_day_opus: "Opus limit",
  seven_day_sonnet: "Sonnet limit",
  // Anthropic's per-model weekly bucket, which Claude Code calls the Fable limit.
  seven_day_overage_included: "Fable limit",
};

export const claudePlanWindowName = (id: ClaudePlanWindowId) =>
  WINDOW_NAMES[id];

/**
 * Why a Claude Code turn ended at a plan limit: dx did not start it or
 * stopped it to keep it off paid extra usage, or the plan had nothing left.
 */
export type ClaudePlanLimitCause = "not-started" | "stopped" | "exhausted";

export interface ClaudePlanLimit {
  readonly window?: ClaudePlanWindowId;
  /** Unix epoch seconds. */
  readonly resetsAt: number;
  readonly cause: ClaudePlanLimitCause;
}

const LIMIT_REASONS: Record<ClaudePlanLimitCause, string> = {
  "not-started":
    "dx did not start Claude Code so it does not run on paid extra usage. To keep working now, choose Allow Extra Usage for Claude Pro/Max in Settings → Model Routing.",
  stopped:
    "dx stopped Claude Code so it does not run on paid extra usage. To keep working now, choose Allow Extra Usage for Claude Pro/Max in Settings → Model Routing.",
  exhausted: "Claude Code cannot run on this plan until then.",
};

/**
 * The turn failure for a plan limit. The web app reads it back with
 * `parseClaudePlanLimit` to show the limit card above the composer.
 */
export const claudePlanLimitText = (limit: ClaudePlanLimit) =>
  `Claude plan limit reached (${
    limit.window === undefined ? "Usage limit" : WINDOW_NAMES[limit.window]
  }, resets ${new Date(limit.resetsAt * 1000).toISOString().slice(0, 16)}Z). ${
    LIMIT_REASONS[limit.cause]
  }`;

const LIMIT_TEXT =
  /Claude plan limit reached \(([^,]+), resets (\d{4}-\d\d-\d\dT\d\d:\d\d)Z\)\. (.+)/;

export const parseClaudePlanLimit = (
  text: string,
): ClaudePlanLimit | undefined => {
  const match = LIMIT_TEXT.exec(text);
  if (match === null) return undefined;
  const [, name, time, reason] = match;
  const resetsAt = Date.parse(`${time}:00Z`) / 1000;
  const cause = (Object.keys(LIMIT_REASONS) as ClaudePlanLimitCause[]).find(
    (key) => reason?.startsWith(LIMIT_REASONS[key]),
  );
  if (!Number.isFinite(resetsAt) || cause === undefined) return undefined;
  const window = ClaudePlanWindowId.literals.find(
    (id) => WINDOW_NAMES[id] === name,
  );
  return { ...(window === undefined ? {} : { window }), resetsAt, cause };
};
