/**
 * When a plugin's jobs run: `every` intervals and five-field cron
 * expressions (UTC). The manifest reader checks schedules with these; the
 * durable host computes next runs with them.
 */

const MINUTE_MS = 60_000;
const EVERY = /^([1-9][0-9]{0,4})([mhd])$/;
export const PLUGIN_JOB_MIN_INTERVAL_MS = MINUTE_MS;
export const PLUGIN_JOB_MAX_INTERVAL_MS = 30 * 24 * 60 * MINUTE_MS;

/** `every`'s interval in milliseconds, or undefined when malformed. */
export const everyMs = (every: string): number | undefined => {
  const match = EVERY.exec(every);
  if (match === null) return undefined;
  const ms =
    Number(match[1]) *
    (match[2] === "m"
      ? MINUTE_MS
      : match[2] === "h"
        ? 60 * MINUTE_MS
        : 24 * 60 * MINUTE_MS);
  return ms >= PLUGIN_JOB_MIN_INTERVAL_MS && ms <= PLUGIN_JOB_MAX_INTERVAL_MS
    ? ms
    : undefined;
};

type CronField = ReadonlySet<number>;
interface Cron {
  readonly minute: CronField;
  readonly hour: CronField;
  readonly day: CronField;
  readonly month: CronField;
  readonly weekday: CronField;
  readonly anyDay: boolean;
  readonly anyWeekday: boolean;
}

const field = (
  text: string,
  min: number,
  max: number,
): CronField | undefined => {
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const match = /^(\*|(\d{1,2})(?:-(\d{1,2}))?)(?:\/(\d{1,2}))?$/.exec(part);
    if (match === null) return undefined;
    const step = match[4] === undefined ? 1 : Number(match[4]);
    const from = match[1] === "*" ? min : Number(match[2]);
    const to =
      match[1] === "*"
        ? max
        : match[3] === undefined
          ? match[4] === undefined
            ? from
            : max
          : Number(match[3]);
    if (step < 1 || from < min || to > max || from > to) return undefined;
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return values;
};

/** A five-field cron expression (minute hour day month weekday), UTC. */
export const parseCron = (expression: string): Cron | undefined => {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5 || expression.length > 100) return undefined;
  const [m, h, d, mo, w] = parts as [string, string, string, string, string];
  const minute = field(m, 0, 59);
  const hour = field(h, 0, 23);
  const day = field(d, 1, 31);
  const month = field(mo, 1, 12);
  // 7 is Sunday too.
  const weekdayRaw = field(w, 0, 7);
  if (!minute || !hour || !day || !month || !weekdayRaw) return undefined;
  const weekday = new Set([...weekdayRaw].map((value) => value % 7));
  return {
    minute,
    hour,
    day,
    month,
    weekday,
    // As in Vixie cron, a field starting with * (also */n) counts as any
    // when deciding whether day of month and day of week combine with OR.
    anyDay: d.startsWith("*"),
    anyWeekday: w.startsWith("*"),
  };
};

/** The first time after `after` the cron matches, within about four years. */
export const nextCronTime = (expression: string, after: number) => {
  const cron = parseCron(expression);
  if (cron === undefined) return undefined;
  const start = new Date(Math.floor(after / MINUTE_MS) * MINUTE_MS + MINUTE_MS);
  const day = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()),
  );
  for (let days = 0; days < 4 * 366; days += 1) {
    const date = new Date(day.getTime() + days * 24 * 60 * MINUTE_MS);
    const dayMatch = cron.day.has(date.getUTCDate());
    const weekdayMatch = cron.weekday.has(date.getUTCDay());
    // As in Vixie cron: when either day field starts with *, both must
    // match; when both are restricted, either one may.
    const matches =
      cron.month.has(date.getUTCMonth() + 1) &&
      (cron.anyDay || cron.anyWeekday
        ? dayMatch && weekdayMatch
        : dayMatch || weekdayMatch);
    if (!matches) continue;
    for (const hour of [...cron.hour].sort((a, b) => a - b))
      for (const minute of [...cron.minute].sort((a, b) => a - b)) {
        const time = date.getTime() + (hour * 60 + minute) * MINUTE_MS;
        if (time >= start.getTime()) return time;
      }
  }
  return undefined;
};

/** When a schedule next runs after `after`; undefined for on-demand. */
export const nextJobRun = (
  schedule: {
    readonly every?: string;
    readonly cron?: string;
    readonly at?: unknown;
  },
  after: number,
): number | undefined =>
  schedule.every !== undefined
    ? (() => {
        const ms = everyMs(schedule.every);
        return ms === undefined ? undefined : after + ms;
      })()
    : schedule.cron !== undefined
      ? nextCronTime(schedule.cron, after)
      : undefined;

/** What `ctx.jobs.schedule` stores for a job, and when it first runs. */
export type ScheduledRun =
  | {
      readonly ok: true;
      readonly schedule:
        | { readonly at: number }
        | { readonly every: string }
        | { readonly cron: string };
      readonly next: number;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * Resolves `ctx.jobs.schedule(id, when)` against the job's declared
 * schedule: `{ at }` is an epoch millisecond, `{ every }` and `{ cron }`
 * repeat, and an empty `when` runs an on-demand job now or keeps a
 * repeating job's declared schedule.
 */
export const resolveScheduledRun = (
  when: {
    readonly at?: unknown;
    readonly every?: unknown;
    readonly cron?: unknown;
  },
  declared: {
    readonly every?: string;
    readonly cron?: string;
    readonly at?: unknown;
  },
  now: number,
): ScheduledRun => {
  if (when.at !== undefined) {
    if (typeof when.at !== "number" || !Number.isFinite(when.at))
      return {
        ok: false,
        reason: `at is an epoch millisecond, such as Date.now() + 60_000, not ${JSON.stringify(when.at)}. To run an on-demand job now, call ctx.jobs.schedule(id) with no schedule.`,
      };
    return {
      ok: true,
      schedule: { at: when.at },
      next: Math.max(now, when.at),
    };
  }
  const repeating =
    when.every !== undefined
      ? { every: String(when.every) }
      : when.cron !== undefined
        ? { cron: String(when.cron) }
        : declared.every !== undefined
          ? { every: declared.every }
          : declared.cron !== undefined
            ? { cron: declared.cron }
            : undefined;
  if (repeating === undefined)
    return { ok: true, schedule: { at: now }, next: now };
  const next = nextJobRun(repeating, now);
  return next === undefined
    ? {
        ok: false,
        reason:
          'A schedule is { at: <epoch ms> }, { every: "5m" } (1m to 30d), or { cron: "0 * * * *" } (five fields, UTC); leave it out to run an on-demand job now.',
      }
    : { ok: true, schedule: repeating, next };
};
