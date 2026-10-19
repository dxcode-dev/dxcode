import {
  type ClaudePlanLimitCause,
  ClaudePlanLimitStatus,
  ClaudePlanReading,
  ClaudePlanUsage,
  type ClaudePlanWindow,
  ClaudePlanWindowId,
  claudePlanBlockedUntil,
  claudePlanExtraUsage,
  claudePlanWindowFamily,
  mergeClaudePlanUsage,
} from "@dx/domain";
import { Option, Schema } from "effect";

/**
 * A Claude Pro/Max plan's limits as Anthropic reports them. The OAuth token
 * from `claude setup-token` carries only the `user:inference` scope, so dx
 * cannot ask Anthropic's usage endpoint. Instead, every response on the plan
 * carries `anthropic-ratelimit-unified-*` headers: the title call and the
 * connection's access check read them directly, and the Claude Code CLI
 * reports them as `rate_limit_event` lines
 * on its stream-json output.
 */

type Json = Record<string, unknown>;

const record = (value: unknown): Json | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined;

const isStatus = Schema.is(ClaudePlanLimitStatus);
const isWindowId = Schema.is(ClaudePlanWindowId);
const decodeReading = (value: unknown) =>
  Option.getOrUndefined(Schema.decodeUnknownOption(ClaudePlanReading)(value));

const seconds = (value: unknown) => {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) && number >= 0
    ? Math.floor(number)
    : undefined;
};

const reason = (value: unknown) =>
  typeof value === "string" && /^[a-z_]{1,64}$/.test(value)
    ? { disabledReason: value }
    : {};

const fraction = (value: unknown) => {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number)
    ? Math.min(100, Math.max(0, number))
    : undefined;
};

const window = (
  id: ClaudePlanWindowId,
  utilization: unknown,
  resetsAt: unknown,
): ClaudePlanWindow[] => {
  const used = fraction(utilization);
  const reset = seconds(resetsAt);
  return used === undefined || reset === undefined
    ? []
    : [{ id, utilization: used, resetsAt: reset }];
};

/** The `rate_limit_info` of a Claude Code `rate_limit_event`. */
export const claudePlanReadingFromEvent = (
  info: unknown,
): ClaudePlanReading | undefined => {
  const value = record(info);
  if (value === undefined || !isStatus(value.status)) return undefined;
  const limitId = isWindowId(value.rateLimitType)
    ? value.rateLimitType
    : undefined;
  const limitReset = seconds(value.resetsAt);
  const unified = record(value.unifiedWindows) ?? {};
  const windows = ClaudePlanWindowId.literals.flatMap((id) => {
    const entry = record(unified[id]);
    return entry === undefined
      ? []
      : window(id, entry.utilization, entry.resetsAt);
  });
  // Older CLIs report only the limiting window.
  if (windows.length === 0 && limitId !== undefined)
    windows.push(...window(limitId, value.utilization, value.resetsAt));
  return decodeReading({
    status: value.status,
    ...(limitId === undefined || limitReset === undefined
      ? {}
      : { limit: { id: limitId, resetsAt: limitReset } }),
    windows,
    extraUsage: {
      ...(isStatus(value.overageStatus) ? { status: value.overageStatus } : {}),
      ...(seconds(value.overageResetsAt) === undefined
        ? {}
        : { resetsAt: seconds(value.overageResetsAt) }),
      inUse: value.isUsingOverage === true || value.overageInUse === true,
      ...reason(value.overageDisabledReason),
    },
  });
};

const HEADER = "anthropic-ratelimit-unified-";

/** The plan's limits from a Messages API response's headers. */
export const claudePlanReadingFromHeaders = (
  headers: Headers,
): ClaudePlanReading | undefined => {
  const header = (name: string) => headers.get(`${HEADER}${name}`) ?? undefined;
  const status = header("status");
  if (!isStatus(status)) return undefined;
  const claim = header("representative-claim");
  const limitId = isWindowId(claim) ? claim : undefined;
  const limitReset = seconds(header("reset"));
  const overageStatus = header("overage-status");
  const overageReset = seconds(header("overage-reset"));
  return decodeReading({
    status,
    ...(limitId === undefined || limitReset === undefined
      ? {}
      : { limit: { id: limitId, resetsAt: limitReset } }),
    windows: [
      ...window("five_hour", header("5h-utilization"), header("5h-reset")),
      ...window("seven_day", header("7d-utilization"), header("7d-reset")),
    ],
    extraUsage: {
      ...(isStatus(overageStatus) ? { status: overageStatus } : {}),
      ...(overageReset === undefined ? {} : { resetsAt: overageReset }),
      inUse: header("overage-in-use") === "true",
      ...reason(header("overage-disabled-reason")),
    },
  });
};

export interface ClaudePlanState {
  readonly allowExtraUsage: boolean;
  readonly usage?: ClaudePlanUsage;
}

const decodeUsage = Schema.decodeUnknownOption(
  Schema.fromJsonString(ClaudePlanUsage),
);

const nowSeconds = () => Math.floor(Date.now() / 1000);

export const loadClaudePlan = async (
  db: D1Database,
  connectionId: string,
): Promise<ClaudePlanState> => {
  const row = await db
    .prepare(
      "SELECT allow_extra_usage, usage FROM claude_code_plan WHERE connection_id = ?",
    )
    .bind(connectionId)
    .first<{ allow_extra_usage: number; usage: string | null }>();
  const usage =
    row?.usage == null
      ? undefined
      : Option.getOrUndefined(decodeUsage(row.usage));
  return {
    allowExtraUsage: row?.allow_extra_usage === 1,
    ...(usage === undefined ? {} : { usage }),
  };
};

/** The window that limits `model`: the limiting one, if it covers it. */
const limitWindowFor = (
  usage: ClaudePlanUsage | undefined,
  model: string,
): ClaudePlanWindowId | undefined => {
  const limit = usage?.limit?.id;
  if (limit === undefined) return undefined;
  const family = claudePlanWindowFamily(limit);
  if (family === undefined || model.includes(family)) return limit;
  return usage?.windows.find(
    ({ id, utilization }) =>
      utilization >= 1 && claudePlanWindowFamily(id) === undefined,
  )?.id;
};

/**
 * The plan state for one launch on `model` (a Claude model id): the extra
 * usage choice, whether the account has extra usage off, which no choice
 * changes, and, when the plan is used up for that model, until when.
 */
export const claudePlanAccess = (state: ClaudePlanState, model: string) => {
  const blockedUntil = claudePlanBlockedUntil(
    state.usage,
    state.allowExtraUsage,
    nowSeconds(),
    model,
  );
  const limitWindow = limitWindowFor(state.usage, model);
  return {
    allowExtraUsage: state.allowExtraUsage,
    ...(claudePlanExtraUsage(state.usage) === "off"
      ? { extraUsageOff: true }
      : {}),
    ...(blockedUntil === undefined ? {} : { blockedUntil }),
    ...(limitWindow === undefined ? {} : { limitWindow }),
  };
};

/**
 * Why dx does not start Claude Code on a blocked plan: its owner keeps it
 * off extra usage, or the account has none to keep it off.
 */
export const claudePlanBlockedCause = (
  plan: ClaudePlanAccess,
): ClaudePlanLimitCause => (plan.extraUsageOff ? "exhausted" : "not-started");

/**
 * Whether a one-token Messages call may read the plan's limits now. While
 * the plan is used up, a call could draw on paid extra usage unless the
 * account has none, so dx waits for the limit to reset.
 */
export const claudePlanReadable = (state: ClaudePlanState) =>
  claudePlanExtraUsage(state.usage) === "off" ||
  claudePlanBlockedUntil(state.usage, false, nowSeconds()) === undefined;

export type ClaudePlanAccess = ReturnType<typeof claudePlanAccess>;

/**
 * Records a reading dx first read at `observedAt` (epoch seconds; never
 * later than now); returns the plan state it produced. A reading older than
 * the stored one is kept out.
 */
export const recordClaudePlanReading = async (
  db: D1Database,
  connectionId: string,
  reading: ClaudePlanReading,
  observedAt: number = nowSeconds(),
): Promise<ClaudePlanState> => {
  const current = await loadClaudePlan(db, connectionId);
  const usage = mergeClaudePlanUsage(
    current.usage,
    reading,
    Math.min(observedAt, nowSeconds()),
  );
  if (usage === current.usage) return current;
  await db
    .prepare(
      `INSERT INTO claude_code_plan (connection_id, usage, updated_at)
       SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM model_connection WHERE id = ?)
       ON CONFLICT (connection_id) DO UPDATE SET
         usage = excluded.usage, updated_at = excluded.updated_at`,
    )
    .bind(
      connectionId,
      JSON.stringify(Schema.encodeSync(ClaudePlanUsage)(usage)),
      new Date().toISOString(),
      connectionId,
    )
    .run();
  return { ...current, usage };
};

export const setClaudePlanExtraUsage = async (
  db: D1Database,
  connectionId: string,
  allowExtraUsage: boolean,
) => {
  await db
    .prepare(
      `INSERT INTO claude_code_plan (connection_id, allow_extra_usage, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT (connection_id) DO UPDATE SET
         allow_extra_usage = excluded.allow_extra_usage,
         updated_at = excluded.updated_at`,
    )
    .bind(connectionId, allowExtraUsage ? 1 : 0, new Date().toISOString())
    .run();
};

/** A new token may be another account: its limits are not known yet. */
export const forgetClaudePlanUsage = async (
  db: D1Database,
  connectionId: string,
) => {
  await db
    .prepare(
      "UPDATE claude_code_plan SET usage = NULL, updated_at = ? WHERE connection_id = ?",
    )
    .bind(new Date().toISOString(), connectionId)
    .run();
};
