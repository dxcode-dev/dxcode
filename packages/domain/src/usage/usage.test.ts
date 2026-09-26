import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  decodeUsageThreadCursor,
  encodeUsageThreadCursor,
  estimateUsageCostMicros,
  normalizeUsageQuery,
  UsageQuery,
} from "./usage.js";

const query = (overrides: Record<string, unknown> = {}) =>
  Schema.decodeUnknownSync(UsageQuery)({
    from: "2026-08-01",
    to: "2026-08-31",
    timezoneOffsetMinutes: 330,
    ...overrides,
  });

describe("usage domain", () => {
  it("normalizes explicit fixed-offset date boundaries deterministically", async () => {
    await expect(
      Effect.runPromise(normalizeUsageQuery(query())),
    ).resolves.toMatchObject({
      fromInclusive: "2026-07-31T18:30:00.000Z",
      toExclusive: "2026-08-31T18:30:00.000Z",
      timezone: "UTC+05:30",
      sqliteTimezoneModifier: "+330 minutes",
    });
  });

  it("rejects invalid calendar dates, reversed ranges, and more than 93 days", async () => {
    for (const input of [
      query({ from: "2026-02-30" }),
      query({ from: "2026-08-31", to: "2026-08-01" }),
      query({ from: "2026-01-01", to: "2026-04-04" }),
    ]) {
      await expect(
        Effect.runPromise(normalizeUsageQuery(input)),
      ).rejects.toMatchObject({
        _tag: "InvalidUsageQuery",
      });
    }
  });

  it("uses integer micro-dollar token math and preserves unknown cost", () => {
    expect(
      estimateUsageCostMicros(
        {
          input: 1_000_000,
          output: 250_000,
          cacheRead: 500_000,
          cacheWrite: 0,
        },
        {
          inputMicrosPerMillion: 2_000_000,
          outputMicrosPerMillion: 8_000_000,
          cacheReadMicrosPerMillion: 200_000,
          cacheWriteMicrosPerMillion: 2_500_000,
        },
      ),
    ).toBe(4_100_000);
    expect(
      estimateUsageCostMicros(
        { input: 1, output: null, cacheRead: 0, cacheWrite: 0 },
        {
          inputMicrosPerMillion: 1,
          outputMicrosPerMillion: 1,
          cacheReadMicrosPerMillion: 1,
          cacheWriteMicrosPerMillion: 1,
        },
      ),
    ).toBeNull();
    expect(
      estimateUsageCostMicros(
        { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        undefined,
      ),
    ).toBeNull();
  });

  it("round-trips a keyset cursor and rejects malformed cursor payloads", async () => {
    const threadId = "thr_00000000-0000-4000-8000-000000000038" as const;
    const cursor = await Effect.runPromise(
      encodeUsageThreadCursor({ estimatedCostMicros: 912, threadId }),
    );
    await expect(
      Effect.runPromise(decodeUsageThreadCursor(cursor)),
    ).resolves.toEqual({
      estimatedCostMicros: 912,
      threadId,
    });
    await expect(
      Effect.runPromise(decodeUsageThreadCursor("bm90LWpzb24" as never)),
    ).rejects.toMatchObject({ _tag: "InvalidUsageQuery", reason: "cursor" });
  });
});
