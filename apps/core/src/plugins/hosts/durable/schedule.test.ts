import { describe, expect, it } from "vitest";
import {
  everyMs,
  nextCronTime,
  nextJobRun,
  parseCron,
  resolveScheduledRun,
} from "./schedule.js";

/*
 * Job schedules decide when a plugin's Durable Object wakes. Ways they
 * could be wrong:
 * - `every` accepts a sub-minute or unbounded interval (an alarm storm);
 * - cron accepts out-of-range or malformed fields;
 * - the next cron time is the current minute again, skips a valid minute,
 *   or mixes day-of-month and day-of-week unlike cron (OR when both are
 *   restricted, `*`/`*\/n` counting as unrestricted);
 * - an impossible date never ends the search;
 * - `ctx.jobs.schedule` takes the manifest's `{ at: "on-demand" }` and
 *   stores a job that never runs, instead of saying what `at` is.
 */
const at = (iso: string) => Date.parse(iso);

describe("job schedules", () => {
  it("bounds every to 1 minute through 30 days", () => {
    expect(everyMs("1m")).toBe(60_000);
    expect(everyMs("2h")).toBe(7_200_000);
    expect(everyMs("30d")).toBe(2_592_000_000);
    for (const bad of ["30s", "0m", "31d", "5", "m", "1.5h", "-1m"])
      expect(everyMs(bad)).toBeUndefined();
  });

  it("refuses malformed cron", () => {
    for (const bad of [
      "* * * *",
      "60 * * * *",
      "* 24 * * *",
      "* * 0 * *",
      "* * * 13 *",
      "* * * * 8",
      "a * * * *",
      "*/0 * * * *",
    ])
      expect(parseCron(bad)).toBeUndefined();
  });

  it("finds the next minute after now, never now", () => {
    expect(nextCronTime("* * * * *", at("2026-11-12T10:00:30Z"))).toBe(
      at("2026-11-12T10:01:00Z"),
    );
    expect(nextCronTime("0 * * * *", at("2026-11-12T10:00:00Z"))).toBe(
      at("2026-11-12T11:00:00Z"),
    );
    expect(nextCronTime("*/15 9-17 * * 1-5", at("2026-11-13T17:50:00Z"))).toBe(
      at("2026-11-16T09:00:00Z"),
    );
  });

  it("ORs restricted day fields and ANDs a starred one, as cron does", () => {
    // The 1st of the month or a Monday: 2026-11-16 is a Monday.
    expect(nextCronTime("0 0 1 * 1", at("2026-11-12T00:00:00Z"))).toBe(
      at("2026-11-16T00:00:00Z"),
    );
    // Odd days of the month that are Mondays: the 16th is even, the 23rd odd.
    expect(nextCronTime("0 0 */2 * 1", at("2026-11-12T00:00:00Z"))).toBe(
      at("2026-11-23T00:00:00Z"),
    );
    expect(
      nextCronTime("0 0 30 2 *", at("2026-11-12T00:00:00Z")),
    ).toBeUndefined();
  });

  it("schedules every from the given time and on-demand never", () => {
    expect(nextJobRun({ every: "5m" }, 1_000)).toBe(301_000);
    expect(nextJobRun({ at: "on-demand" }, 1_000)).toBeUndefined();
  });
});

describe("ctx.jobs.schedule", () => {
  const now = at("2026-11-13T10:00:00Z");
  const onDemand = { at: "on-demand" };

  it("runs an on-demand job now when no schedule is given", () => {
    expect(resolveScheduledRun({}, onDemand, now)).toEqual({
      ok: true,
      schedule: { at: now },
      next: now,
    });
  });

  it("keeps a repeating job's declared schedule when none is given", () => {
    expect(resolveScheduledRun({}, { every: "5m" }, now)).toEqual({
      ok: true,
      schedule: { every: "5m" },
      next: now + 300_000,
    });
  });

  it("runs at an epoch millisecond, never in the past", () => {
    expect(
      resolveScheduledRun({ at: now + 60_000 }, onDemand, now),
    ).toMatchObject({
      ok: true,
      next: now + 60_000,
    });
    expect(
      resolveScheduledRun({ at: now - 60_000 }, onDemand, now),
    ).toMatchObject({
      ok: true,
      next: now,
    });
  });

  it("refuses the manifest's on-demand form, saying what at is", () => {
    for (const bad of ["on-demand", "2026-11-13", Number.NaN, null]) {
      const run = resolveScheduledRun({ at: bad }, onDemand, now);
      expect(run.ok).toBe(false);
      if (!run.ok) {
        expect(run.reason).toContain("epoch millisecond");
        expect(run.reason).toContain("ctx.jobs.schedule(id) with no schedule");
      }
    }
  });

  it("refuses an every or cron dx cannot read", () => {
    expect(resolveScheduledRun({ every: "30s" }, onDemand, now).ok).toBe(false);
    expect(resolveScheduledRun({ cron: "* * *" }, onDemand, now).ok).toBe(
      false,
    );
  });
});
