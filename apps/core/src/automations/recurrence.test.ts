import { describe, expect, it } from "vitest";
import {
  isTimeZone,
  nextOccurrence,
  parseRecurrence,
  RecurrenceInvalid,
  zoneFormatterCache,
} from "./recurrence.js";

/*
 * Ways a schedule's next firing can go wrong, which these cases pin down:
 * - the wall-clock time drifts across a daylight-saving change;
 * - a half-hour offset zone (Asia/Kolkata) is read as a whole-hour one;
 * - a local time that does not exist (spring forward) is dropped or a time
 *   that exists twice (fall back) fires twice;
 * - INTERVAL counts from the wrong week or month;
 * - a month without day 31 is given a wrong date instead of being skipped;
 * - ordinal weekdays (1MO, -1FR) pick the wrong week;
 * - "after" is inclusive where it must be strict, so a firing repeats;
 * - COUNT or UNTIL lets one more firing through;
 * - a DTSTART long in the past fires for every missed occurrence;
 * - an omitted DTSTART is anchored in UTC instead of the owner's zone;
 * - an unsupported or never-firing rule is accepted and silently never runs;
 * - a rule that fires more often than the minimum spacing is accepted;
 * - an hourly or minutely rule that never matches burns CPU for minutes
 *   before it is refused, or a sparse valid one is refused by the bound.
 */

const at = (iso: string) => new Date(iso);
const now = at("2026-10-24T06:07:31Z");

describe("parseRecurrence", () => {
  it("anchors an omitted DTSTART at the current minute in the owner's zone", () => {
    const rule = parseRecurrence("RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0", {
      now,
      timeZone: "Asia/Kolkata",
    });
    expect(rule.dtstart.toISOString()).toBe("2026-10-24T06:07:00.000Z");
    expect(rule.timeZone).toBe("Asia/Kolkata");
    expect(rule.text).toBe(
      "DTSTART;TZID=Asia/Kolkata:20261024T113700\nRRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
    );
    // 09:00 in Kolkata is 03:30 UTC; today's has passed, so tomorrow's.
    expect(nextOccurrence(rule, now, 0)?.toISOString()).toBe(
      "2026-10-25T03:30:00.000Z",
    );
  });

  it("honours an explicit DTSTART zone over the owner's", () => {
    const rule = parseRecurrence(
      "DTSTART;TZID=America/New_York:20261101T090000\nRRULE:FREQ=DAILY;COUNT=3",
      { now, timeZone: "Asia/Kolkata" },
    );
    expect(rule.timeZone).toBe("America/New_York");
    expect(rule.count).toBe(3);
  });

  it("accepts a UTC DTSTART and lowercase, unprefixed rules", () => {
    const rule = parseRecurrence(
      "DTSTART:20261024T120000Z freq=daily;count=1",
      { now, timeZone: "Asia/Kolkata" },
    );
    expect(rule.dtstart.toISOString()).toBe("2026-10-24T12:00:00.000Z");
    expect(nextOccurrence(rule, now, 0, true)?.toISOString()).toBe(
      "2026-10-24T12:00:00.000Z",
    );
  });

  it.each([
    ["RRULE:FREQ=SECONDLY", /FREQ/],
    ["RRULE:FREQ=MONTHLY;BYSETPOS=1;BYDAY=MO", /BYSETPOS/],
    ["RRULE:FREQ=MINUTELY;INTERVAL=1", /5 minutes/],
    ["RRULE:FREQ=HOURLY;BYMINUTE=0,1,2", /5 minutes/],
    ["RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30", /never/],
    ["RRULE:FREQ=DAILY;COUNT=0", /COUNT/],
    ["RRULE:FREQ=DAILY;UNTIL=20200101T000000Z", /never/],
    ["DTSTART;TZID=Mars/Olympus:20261024T090000\nRRULE:FREQ=DAILY", /zone/],
    ["", /RRULE/],
  ])("rejects %j", (text, message) => {
    expect(() => parseRecurrence(text, { now, timeZone: "UTC" })).toThrow(
      RecurrenceInvalid,
    );
    expect(() => parseRecurrence(text, { now, timeZone: "UTC" })).toThrow(
      message,
    );
  });
});

describe("bounded scans", () => {
  const everyMinute = Array.from({ length: 60 }, (_, minute) => minute).join();

  it.each([
    `RRULE:FREQ=MINUTELY;INTERVAL=5;BYMONTH=2;BYMONTHDAY=30`,
    `RRULE:FREQ=HOURLY;BYMONTH=2;BYMONTHDAY=30;BYMINUTE=${everyMinute}`,
    `RRULE:FREQ=HOURLY;INTERVAL=24;BYHOUR=5;BYMINUTE=${everyMinute}`,
  ])("refuses the never-matching %j within a bounded scan", (text) => {
    const started = performance.now();
    expect(() =>
      parseRecurrence(`DTSTART:20261024T030000Z\n${text}`, {
        now,
        timeZone: "UTC",
      }),
    ).toThrow(/never/);
    expect(performance.now() - started).toBeLessThan(3_000);
  });

  it.each([
    ["RRULE:FREQ=MINUTELY;INTERVAL=305", "2026-10-24T10:10:00.000Z"],
    [
      "RRULE:FREQ=MINUTELY;INTERVAL=5;BYMONTH=2;BYMONTHDAY=29;BYHOUR=23;BYMINUTE=55",
      "2028-02-29T23:55:00.000Z",
    ],
    [
      "RRULE:FREQ=HOURLY;BYMONTH=2;BYMONTHDAY=29;BYMINUTE=0,15,30,45",
      "2028-02-29T00:00:00.000Z",
    ],
  ])("still finds the sparse but valid %j", (text, expected) => {
    const rule = parseRecurrence(`DTSTART:20261024T000000Z\n${text}`, {
      now,
      timeZone: "UTC",
    });
    expect(nextOccurrence(rule, now, 0, true)?.toISOString()).toBe(expected);
  });
});

describe("nextOccurrence", () => {
  it("keeps the wall-clock time across a daylight-saving change", () => {
    const rule = parseRecurrence(
      "DTSTART;TZID=America/New_York:20261030T090000\nRRULE:FREQ=DAILY",
      { now, timeZone: "UTC" },
    );
    // EDT (UTC-4) before 1 November, EST (UTC-5) after.
    expect(
      nextOccurrence(rule, at("2026-10-31T13:00:00Z"), 0)?.toISOString(),
    ).toBe("2026-11-01T14:00:00.000Z");
    expect(
      nextOccurrence(rule, at("2026-10-30T12:00:00Z"), 0)?.toISOString(),
    ).toBe("2026-10-30T13:00:00.000Z");
  });

  it("moves a time skipped by spring-forward to after the gap", () => {
    const rule = parseRecurrence(
      "DTSTART;TZID=America/New_York:20270313T023000\nRRULE:FREQ=DAILY",
      { now, timeZone: "UTC" },
    );
    // 14 March 2027 has no 02:30 in New York; 03:30 EDT is 07:30 UTC.
    expect(
      nextOccurrence(rule, at("2027-03-13T08:00:00Z"), 0)?.toISOString(),
    ).toBe("2027-03-14T07:30:00.000Z");
  });

  it("fires a time repeated by fall-back once, at its first instance", () => {
    const rule = parseRecurrence(
      "DTSTART;TZID=America/New_York:20261031T013000\nRRULE:FREQ=DAILY",
      { now, timeZone: "UTC" },
    );
    const first = nextOccurrence(rule, at("2026-10-31T12:00:00Z"), 0);
    // 01:30 EDT on 1 November is 05:30 UTC; 01:30 EST (06:30 UTC) is skipped.
    expect(first?.toISOString()).toBe("2026-11-01T05:30:00.000Z");
    expect(nextOccurrence(rule, first as Date, 1)?.toISOString()).toBe(
      "2026-11-02T06:30:00.000Z",
    );
  });

  it("is strictly after the given instant unless asked to include it", () => {
    const rule = parseRecurrence(
      "DTSTART;TZID=UTC:20261024T090000\nRRULE:FREQ=DAILY",
      { now, timeZone: "UTC" },
    );
    const nine = at("2026-10-24T09:00:00Z");
    expect(nextOccurrence(rule, nine, 0)?.toISOString()).toBe(
      "2026-10-25T09:00:00.000Z",
    );
    expect(nextOccurrence(rule, nine, 0, true)?.toISOString()).toBe(
      "2026-10-24T09:00:00.000Z",
    );
  });

  it("does not replay occurrences missed since a DTSTART long past", () => {
    const rule = parseRecurrence(
      "DTSTART;TZID=UTC:20240101T090000\nRRULE:FREQ=DAILY",
      { now, timeZone: "UTC" },
    );
    expect(nextOccurrence(rule, now, 5)?.toISOString()).toBe(
      "2026-10-24T09:00:00.000Z",
    );
  });

  it("counts WEEKLY intervals from DTSTART's week, on every BYDAY", () => {
    // Saturday 24 October 2026; every other week on Monday and Thursday.
    const rule = parseRecurrence(
      "DTSTART;TZID=UTC:20261024T100000\nRRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH",
      { now, timeZone: "UTC" },
    );
    const fired: string[] = [];
    let cursor = at("2026-10-24T00:00:00Z");
    for (let index = 0; index < 4; index++) {
      const next = nextOccurrence(rule, cursor, index) as Date;
      fired.push(next.toISOString().slice(0, 10));
      cursor = next;
    }
    // DTSTART's week (19–25 Oct) has no Monday or Thursday left; the next
    // counted week is 2–8 November, then 16–22 November.
    expect(fired).toEqual([
      "2026-11-02",
      "2026-11-05",
      "2026-11-16",
      "2026-11-19",
    ]);
  });

  it("skips months without the day rather than inventing a date", () => {
    const rule = parseRecurrence(
      "DTSTART;TZID=UTC:20260131T080000\nRRULE:FREQ=MONTHLY;BYMONTHDAY=31",
      { now, timeZone: "UTC" },
    );
    expect(
      nextOccurrence(rule, at("2026-10-31T09:00:00Z"), 0)?.toISOString(),
    ).toBe("2026-12-31T08:00:00.000Z");
  });

  it("reads negative month days and ordinal weekdays from the month's end", () => {
    const last = parseRecurrence(
      "DTSTART;TZID=UTC:20260101T080000\nRRULE:FREQ=MONTHLY;BYMONTHDAY=-1",
      { now, timeZone: "UTC" },
    );
    expect(
      nextOccurrence(last, at("2027-02-01T00:00:00Z"), 0)?.toISOString(),
    ).toBe("2027-02-28T08:00:00.000Z");
    const lastFriday = parseRecurrence(
      "DTSTART;TZID=UTC:20260101T080000\nRRULE:FREQ=MONTHLY;BYDAY=-1FR",
      { now, timeZone: "UTC" },
    );
    expect(nextOccurrence(lastFriday, now, 0)?.toISOString()).toBe(
      "2026-10-30T08:00:00.000Z",
    );
    const firstMonday = parseRecurrence(
      "DTSTART;TZID=UTC:20260101T080000\nRRULE:FREQ=MONTHLY;BYDAY=1MO",
      { now, timeZone: "UTC" },
    );
    expect(nextOccurrence(firstMonday, now, 0)?.toISOString()).toBe(
      "2026-11-02T08:00:00.000Z",
    );
  });

  it("stops after COUNT firings and at UNTIL, inclusive", () => {
    const once = parseRecurrence("RRULE:FREQ=DAILY;COUNT=1", {
      now,
      timeZone: "UTC",
    });
    // A schedule's first firing is looked up from its DTSTART, inclusive.
    expect(nextOccurrence(once, once.dtstart, 0, true)?.toISOString()).toBe(
      "2026-10-24T06:07:00.000Z",
    );
    expect(nextOccurrence(once, now, 1)).toBeUndefined();
    const until = parseRecurrence(
      "DTSTART;TZID=UTC:20261024T090000\nRRULE:FREQ=DAILY;UNTIL=20261026T090000Z",
      { now, timeZone: "UTC" },
    );
    expect(
      nextOccurrence(until, at("2026-10-25T09:00:00Z"), 2)?.toISOString(),
    ).toBe("2026-10-26T09:00:00.000Z");
    expect(
      nextOccurrence(until, at("2026-10-26T09:00:00Z"), 3),
    ).toBeUndefined();
  });

  it("steps HOURLY rules from DTSTART and filters by local hour", () => {
    const rule = parseRecurrence(
      "DTSTART;TZID=Asia/Kolkata:20261024T090000\nRRULE:FREQ=HOURLY;INTERVAL=3;BYHOUR=9,12,15,18",
      { now, timeZone: "UTC" },
    );
    // 11:37 IST now; the 3-hourly steps from 09:00 IST are 12:00, 15:00, …
    expect(nextOccurrence(rule, now, 0)?.toISOString()).toBe(
      "2026-10-24T06:30:00.000Z",
    );
    expect(
      nextOccurrence(rule, at("2026-10-24T12:30:00Z"), 0)?.toISOString(),
    ).toBe("2026-10-25T03:30:00.000Z");
  });
});

/*
 * Ways a time-zone formatter cache can grow without bound, which these cases
 * pin down: each letter-case spelling of one zone gets its own formatter;
 * checking a zone with `isTimeZone` caches one; the cache never drops one.
 */
describe("time-zone formatter cache", () => {
  it("keeps one formatter per zone, however its name is spelled", () => {
    const formatter = zoneFormatterCache({ hour: "numeric" });
    const canonical = formatter("America/New_York");
    for (const spelling of [
      "america/new_york",
      "AMERICA/NEW_YORK",
      "aMeRiCa/nEw_YoRk",
    ])
      expect(formatter(spelling)).toBe(canonical);
    expect(formatter("aMeRiCa/nEw_YoRk").resolvedOptions().timeZone).toBe(
      "America/New_York",
    );
    expect(() => formatter("Not/A_Zone")).toThrow(RangeError);
  });

  it("drops its oldest formatter past the limit", () => {
    const formatter = zoneFormatterCache({ hour: "numeric" }, 2);
    const first = formatter("Europe/Paris");
    formatter("Asia/Kolkata");
    expect(formatter("Europe/Paris")).toBe(first);
    formatter("America/Chicago");
    expect(formatter("Europe/Paris")).not.toBe(first);
  });

  it("accepts a known zone in any letter case and refuses an unknown one", () => {
    expect(isTimeZone("aMeRiCa/nEw_YoRk")).toBe(true);
    expect(isTimeZone("UTC")).toBe(true);
    expect(isTimeZone("Not/A_Zone")).toBe(false);
  });
});
