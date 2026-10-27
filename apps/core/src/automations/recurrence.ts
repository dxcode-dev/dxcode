/**
 * RFC 5545 recurrence rules for Thread schedules: the subset an agent needs
 * to say "every weekday at 9", "the last Friday of each month", or "once, at
 * 17:30". Occurrences are wall-clock times in the rule's IANA time zone, so a
 * daily 09:00 stays 09:00 across daylight-saving changes.
 *
 * COUNT counts firings, not occurrences since DTSTART: a schedule that was
 * paused or created with a past DTSTART fires its next occurrence and never
 * replays the ones it missed. The caller passes how many times it fired.
 */

/** A rule dx refuses, with a message the agent can act on. */
export class RecurrenceInvalid extends Error {
  override readonly name = "RecurrenceInvalid";
}

type Frequency =
  | "MINUTELY"
  | "HOURLY"
  | "DAILY"
  | "WEEKLY"
  | "MONTHLY"
  | "YEARLY";

interface LocalTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

interface WeekdayRule {
  /** Monday is 0. */
  readonly weekday: number;
  readonly ordinal?: number;
}

export interface Recurrence {
  /** The rule as stored: an explicit DTSTART line, then the RRULE line. */
  readonly text: string;
  readonly dtstart: Date;
  readonly timeZone: string;
  readonly count?: number;
  readonly until?: Date;
  readonly frequency: Frequency;
  readonly interval: number;
  readonly start: LocalTime;
  readonly byMonth?: ReadonlyArray<number>;
  readonly byMonthDay?: ReadonlyArray<number>;
  readonly byDay?: ReadonlyArray<WeekdayRule>;
  readonly byHour?: ReadonlyArray<number>;
  readonly byMinute?: ReadonlyArray<number>;
}

/** The closest two firings may be. Closer than this is polling. */
export const MIN_SPACING_MS = 5 * 60_000;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** How far ahead a date-stepped rule looks for its next occurrence. */
const SCAN_DAYS = 3_700;
/** How many steps an hourly or minutely rule tries. */
const SCAN_STEPS = 250_000;
const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
const FREQUENCIES: ReadonlyArray<Frequency> = [
  "MINUTELY",
  "HOURLY",
  "DAILY",
  "WEEKLY",
  "MONTHLY",
  "YEARLY",
];
const PARTS = new Set([
  "FREQ",
  "INTERVAL",
  "COUNT",
  "UNTIL",
  "BYDAY",
  "BYMONTHDAY",
  "BYMONTH",
  "BYHOUR",
  "BYMINUTE",
  "WKST",
]);

const formatters = new Map<string, Intl.DateTimeFormat>();

const formatter = (timeZone: string) => {
  let format = formatters.get(timeZone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, format);
  }
  return format;
};

/** Whether the runtime knows an IANA time zone. */
export const isTimeZone = (timeZone: string) => {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
};

/** The wall-clock time at an instant in a zone, to the minute. */
export const localTime = (instant: number, timeZone: string): LocalTime => {
  const parts = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(new Date(instant))
      .map(({ type, value }) => [type, Number(value)]),
  ) as Record<string, number>;
  return {
    year: parts.year as number,
    month: parts.month as number,
    day: parts.day as number,
    hour: (parts.hour as number) % 24,
    minute: parts.minute as number,
  };
};

const wallMs = (time: LocalTime) =>
  Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute);

const offsetAt = (instant: number, timeZone: string) =>
  wallMs(localTime(instant, timeZone)) -
  Math.floor(instant / MINUTE_MS) * MINUTE_MS;

/**
 * The instant a wall-clock time names. A time repeated by a fall-back change
 * is its first instance; a time skipped by spring-forward is read with the
 * offset before the gap, which lands the same distance past it.
 */
export const zonedInstant = (time: LocalTime, timeZone: string) => {
  const wall = wallMs(time);
  const before = wall - offsetAt(wall - DAY_MS, timeZone);
  const after = wall - offsetAt(wall + DAY_MS, timeZone);
  const valid = [before, after].filter(
    (candidate) => wallMs(localTime(candidate, timeZone)) === wall,
  );
  return valid.length === 0 ? before : Math.min(...valid);
};

/** Days since 1970-01-01 for a calendar date. */
const dayNumber = (year: number, month: number, day: number) =>
  Date.UTC(year, month - 1, day) / DAY_MS;

const dateOf = (number: number) => {
  const date = new Date(number * DAY_MS);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
};

/** Monday is 0; 1970-01-01 was a Thursday. */
const weekdayOf = (number: number) => (((number + 3) % 7) + 7) % 7;
/** Weeks start on Monday (WKST=MO). */
const weekOf = (number: number) => Math.floor((number + 3) / 7);
const daysInMonth = (year: number, month: number) =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

const formatLocal = (time: LocalTime) =>
  `${pad(time.year, 4)}${pad(time.month)}${pad(time.day)}T${pad(time.hour)}${pad(time.minute)}00`;

const invalid = (message: string): never => {
  throw new RecurrenceInvalid(message);
};

const parseDateTime = (
  value: string,
  timeZone: string,
  what: string,
): number => {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/i.exec(
    value,
  );
  if (match === null)
    return invalid(
      `${what} must look like 20261024T090000, 20261024T090000Z, or 20261024.`,
    );
  const [, year, month, day, hour, minute, , utc] = match;
  const time: LocalTime = {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour ?? (what === "UNTIL" ? 23 : 0)),
    minute: Number(minute ?? (what === "UNTIL" ? 59 : 0)),
  };
  if (
    time.month < 1 ||
    time.month > 12 ||
    time.day < 1 ||
    time.day > daysInMonth(time.year, time.month) ||
    time.hour > 23 ||
    time.minute > 59
  )
    return invalid(`${what} is not a real date and time.`);
  return utc === undefined ? zonedInstant(time, timeZone) : wallMs(time);
};

const integers = (
  name: string,
  value: string,
  minimum: number,
  maximum: number,
  allowNegative = false,
) =>
  value.split(",").map((item) => {
    const number = Number(item);
    if (
      !/^[+-]?\d+$/.test(item) ||
      (number === 0 && minimum > 0) ||
      Math.abs(number) > maximum ||
      (!allowNegative && number < minimum)
    )
      return invalid(`${name} has an invalid value: ${item}.`);
    return number;
  });

const sorted = (values: ReadonlyArray<number>) =>
  [...new Set(values)].sort((left, right) => left - right);

/**
 * Parses `DTSTART…` and `RRULE:…` (in either order, separated by spaces or
 * newlines). Without DTSTART the rule starts at the current minute in the
 * owner's zone; a DTSTART without a zone is read in the owner's zone too.
 */
export const parseRecurrence = (
  input: string,
  defaults: { readonly now: Date; readonly timeZone: string },
): Recurrence => {
  if (!isTimeZone(defaults.timeZone))
    invalid(`Unknown time zone ${defaults.timeZone}.`);
  let dtstartToken: string | undefined;
  let ruleToken: string | undefined;
  for (const token of input.trim().split(/\s+/).filter(Boolean)) {
    if (/^DTSTART[;:]/i.test(token)) {
      if (dtstartToken !== undefined) invalid("Give DTSTART once.");
      dtstartToken = token;
    } else if (/^(RRULE:)?FREQ=/i.test(token) || /^RRULE:/i.test(token)) {
      if (ruleToken !== undefined) invalid("Give one RRULE.");
      ruleToken = token.replace(/^RRULE:/i, "");
    } else invalid(`Unexpected text in the schedule: ${token}.`);
  }
  if (ruleToken === undefined)
    return invalid(
      'The schedule needs an RRULE, such as "RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0".',
    );

  let timeZone = defaults.timeZone;
  let dtstart = Math.floor(defaults.now.getTime() / MINUTE_MS) * MINUTE_MS;
  if (dtstartToken !== undefined) {
    const match = /^DTSTART(?:;TZID=([^:;]+))?:(.+)$/i.exec(dtstartToken);
    if (match === null) return invalid("DTSTART is malformed.");
    const [, zone, value = ""] = match;
    if (zone !== undefined) {
      if (!isTimeZone(zone)) invalid(`Unknown time zone ${zone}.`);
      timeZone = zone;
    } else if (/Z$/i.test(value)) timeZone = "UTC";
    dtstart = parseDateTime(value, timeZone, "DTSTART");
  }

  const parts = new Map<string, string>();
  const order: string[] = [];
  for (const part of ruleToken.split(";").filter(Boolean)) {
    const [rawName = "", rawValue = "", ...rest] = part.split("=");
    const name = rawName.toUpperCase();
    if (rest.length > 0 || rawValue === "")
      invalid(`RRULE part ${part} is malformed.`);
    if (!PARTS.has(name))
      invalid(
        `${name} is not supported. Use FREQ, INTERVAL, COUNT, UNTIL, BYDAY, BYMONTHDAY, BYMONTH, BYHOUR, and BYMINUTE.`,
      );
    if (parts.has(name)) invalid(`${name} appears twice.`);
    parts.set(name, name === "UNTIL" ? rawValue : rawValue.toUpperCase());
    order.push(`${name}=${parts.get(name)}`);
  }
  const frequency = parts.get("FREQ") as Frequency | undefined;
  if (frequency === undefined || !FREQUENCIES.includes(frequency))
    return invalid(
      `FREQ must be one of ${FREQUENCIES.join(", ")}; minimum spacing is 5 minutes.`,
    );
  const interval = Number(parts.get("INTERVAL") ?? "1");
  if (!Number.isInteger(interval) || interval < 1 || interval > 1_000)
    invalid("INTERVAL must be a whole number from 1 to 1000.");
  const countText = parts.get("COUNT");
  const count = countText === undefined ? undefined : Number(countText);
  if (
    count !== undefined &&
    (!/^\d+$/.test(countText as string) || count < 1 || count > 100_000)
  )
    invalid("COUNT must be a whole number of at least 1.");
  if (parts.has("WKST") && parts.get("WKST") !== "MO")
    invalid("Only WKST=MO is supported.");
  const untilText = parts.get("UNTIL");
  const until =
    untilText === undefined
      ? undefined
      : parseDateTime(untilText, timeZone, "UNTIL");
  if (count !== undefined && until !== undefined)
    invalid("Use COUNT or UNTIL, not both.");

  const byDay = parts
    .get("BYDAY")
    ?.split(",")
    .map((item): WeekdayRule => {
      const match = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/.exec(item);
      if (match === null)
        return invalid(`BYDAY has an invalid value: ${item}.`);
      const weekday = WEEKDAYS.indexOf(match[2] as (typeof WEEKDAYS)[number]);
      if (match[1] === undefined) return { weekday };
      const ordinal = Number(match[1]);
      if (ordinal === 0 || Math.abs(ordinal) > 5)
        return invalid(`BYDAY has an invalid value: ${item}.`);
      return { weekday, ordinal };
    });
  const byMonth = parts.has("BYMONTH")
    ? sorted(integers("BYMONTH", parts.get("BYMONTH") as string, 1, 12))
    : undefined;
  const byMonthDay = parts.has("BYMONTHDAY")
    ? sorted(
        integers("BYMONTHDAY", parts.get("BYMONTHDAY") as string, 1, 31, true),
      )
    : undefined;
  const byHour = parts.has("BYHOUR")
    ? sorted(integers("BYHOUR", parts.get("BYHOUR") as string, 0, 23))
    : undefined;
  const byMinute = parts.has("BYMINUTE")
    ? sorted(integers("BYMINUTE", parts.get("BYMINUTE") as string, 0, 59))
    : undefined;
  const ordinals = byDay?.some(({ ordinal }) => ordinal !== undefined);
  if (
    ordinals &&
    frequency !== "MONTHLY" &&
    !(frequency === "YEARLY" && byMonth !== undefined)
  )
    invalid(
      "BYDAY ordinals such as 1MO need FREQ=MONTHLY, or YEARLY with BYMONTH.",
    );
  if (frequency === "MINUTELY" && interval * MINUTE_MS < MIN_SPACING_MS)
    invalid("A schedule may fire at most once every 5 minutes.");

  const start = localTime(dtstart, timeZone);
  const rule: Recurrence = {
    text: `DTSTART;TZID=${timeZone}:${formatLocal(start)}\nRRULE:${order.join(";")}`,
    dtstart: new Date(dtstart),
    timeZone,
    frequency,
    interval,
    start,
    ...(count === undefined ? {} : { count }),
    ...(until === undefined ? {} : { until: new Date(until) }),
    ...(byMonth === undefined ? {} : { byMonth }),
    ...(byMonthDay === undefined ? {} : { byMonthDay }),
    ...(byDay === undefined ? {} : { byDay }),
    ...(byHour === undefined ? {} : { byHour }),
    ...(byMinute === undefined ? {} : { byMinute }),
  };

  // Refuse a rule that would never fire, or fire closer than the minimum.
  const first = nextOccurrence(
    rule,
    new Date(Math.max(dtstart, defaults.now.getTime() - MINUTE_MS)),
    0,
    true,
  );
  if (first === undefined) invalid("This schedule would never fire.");
  let previous = first as Date;
  for (let index = 1; index < 50; index++) {
    const next = nextOccurrence(rule, previous, index);
    if (next === undefined) break;
    if (next.getTime() - previous.getTime() < MIN_SPACING_MS)
      invalid("A schedule may fire at most once every 5 minutes.");
    previous = next;
  }
  return rule;
};

const matchesMonthDay = (
  values: ReadonlyArray<number>,
  day: number,
  length: number,
) => values.some((value) => (value > 0 ? value : length + value + 1) === day);

const matchesWeekday = (
  rules: ReadonlyArray<WeekdayRule>,
  day: number,
  weekday: number,
  length: number,
) =>
  rules.some((rule) => {
    if (rule.weekday !== weekday) return false;
    if (rule.ordinal === undefined) return true;
    return rule.ordinal > 0
      ? Math.ceil(day / 7) === rule.ordinal
      : Math.floor((length - day) / 7) + 1 === -rule.ordinal;
  });

/** Whether a calendar day, by its BY parts, can hold an occurrence. */
const dayMatches = (rule: Recurrence, number: number) => {
  const { year, month, day } = dateOf(number);
  const weekday = weekdayOf(number);
  const length = daysInMonth(year, month);
  if (rule.byMonth !== undefined && !rule.byMonth.includes(month)) return false;
  if (
    rule.byMonthDay !== undefined &&
    !matchesMonthDay(rule.byMonthDay, day, length)
  )
    return false;
  if (
    rule.byDay !== undefined &&
    !matchesWeekday(rule.byDay, day, weekday, length)
  )
    return false;
  const { start } = rule;
  switch (rule.frequency) {
    case "WEEKLY":
      return (
        rule.byDay !== undefined ||
        rule.byMonthDay !== undefined ||
        weekday === weekdayOf(dayNumber(start.year, start.month, start.day))
      );
    case "MONTHLY":
      return (
        rule.byDay !== undefined ||
        rule.byMonthDay !== undefined ||
        day === start.day
      );
    case "YEARLY":
      return (
        (rule.byDay !== undefined || rule.byMonthDay !== undefined
          ? true
          : day === start.day) &&
        (rule.byMonth !== undefined ||
          rule.byDay !== undefined ||
          rule.byMonthDay !== undefined ||
          month === start.month)
      );
    default:
      return true;
  }
};

/** Whether a day lies in a period INTERVAL selects. */
const periodMatches = (rule: Recurrence, number: number) => {
  const { start } = rule;
  const startDay = dayNumber(start.year, start.month, start.day);
  const { year, month } = dateOf(number);
  const distance = (() => {
    switch (rule.frequency) {
      case "WEEKLY":
        return weekOf(number) - weekOf(startDay);
      case "MONTHLY":
        return year * 12 + month - (start.year * 12 + start.month);
      case "YEARLY":
        return year - start.year;
      default:
        return number - startDay;
    }
  })();
  return distance >= 0 && distance % rule.interval === 0;
};

/**
 * The first occurrence after `after` (at or after it when `inclusive`), or
 * undefined when COUNT firings have happened, UNTIL has passed, or nothing
 * occurs within ten years.
 */
export const nextOccurrence = (
  rule: Recurrence,
  after: Date,
  fired: number,
  inclusive = false,
): Date | undefined => {
  if (rule.count !== undefined && fired >= rule.count) return undefined;
  const floor = Math.max(after.getTime(), rule.dtstart.getTime());
  const accepts = (instant: number) =>
    instant >= rule.dtstart.getTime() &&
    (inclusive ? instant >= after.getTime() : instant > after.getTime()) &&
    (rule.until === undefined || instant <= rule.until.getTime());
  const beyondUntil = (instant: number) =>
    rule.until !== undefined && instant > rule.until.getTime();

  if (rule.frequency === "HOURLY" || rule.frequency === "MINUTELY") {
    const step =
      rule.interval * (rule.frequency === "HOURLY" ? 60 : 1) * MINUTE_MS;
    const base = rule.dtstart.getTime();
    const first = Math.max(0, Math.floor((floor - base) / step) - 1);
    const minutes =
      rule.frequency === "HOURLY" && rule.byMinute !== undefined
        ? rule.byMinute.map((minute) => minute - rule.start.minute)
        : [0];
    for (let index = first; index < first + SCAN_STEPS; index++) {
      for (const shift of minutes) {
        const instant = base + index * step + shift * MINUTE_MS;
        if (beyondUntil(instant)) return undefined;
        const local = localTime(instant, rule.timeZone);
        const day = dayNumber(local.year, local.month, local.day);
        if (
          accepts(instant) &&
          dayMatches({ ...rule, frequency: "DAILY" }, day) &&
          (rule.byHour === undefined || rule.byHour.includes(local.hour)) &&
          (rule.frequency === "HOURLY" ||
            rule.byMinute === undefined ||
            rule.byMinute.includes(local.minute))
        )
          return new Date(instant);
      }
    }
    return undefined;
  }

  const hours = rule.byHour ?? [rule.start.hour];
  const minutes = rule.byMinute ?? [rule.start.minute];
  const local = localTime(floor, rule.timeZone);
  const firstDay = dayNumber(local.year, local.month, local.day) - 1;
  for (let number = firstDay; number < firstDay + SCAN_DAYS; number++) {
    if (!periodMatches(rule, number) || !dayMatches(rule, number)) continue;
    const date = dateOf(number);
    for (const hour of hours)
      for (const minute of minutes) {
        const instant = zonedInstant({ ...date, hour, minute }, rule.timeZone);
        if (beyondUntil(instant)) return undefined;
        if (accepts(instant)) return new Date(instant);
      }
  }
  return undefined;
};
