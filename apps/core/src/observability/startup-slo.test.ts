import { describe, expect, it } from "vitest";
import { evaluateStartupSlo, startupSloTargets } from "./startup-slo.js";

describe("startup SLO evaluator", () => {
  it("uses exact nearest-rank p95 and p99 without mutating samples", () => {
    const durationsMs = [
      20, 1, 19, 2, 18, 3, 17, 4, 16, 5, 15, 6, 14, 7, 13, 8, 12, 9, 11, 10,
    ];

    expect(
      evaluateStartupSlo(
        durationsMs.map((durationMs) => ({
          outcome: "reached" as const,
          durationMs,
        })),
        startupSloTargets.threadCreate,
      ),
    ).toEqual({
      eligible: 20,
      reached: 20,
      successRate: 1,
      p95Ms: 19,
      p99Ms: 20,
      meetsObjective: true,
    });
    expect(durationsMs).toEqual([
      20, 1, 19, 2, 18, 3, 17, 4, 16, 5, 15, 6, 14, 7, 13, 8, 12, 9, 11, 10,
    ]);
  });

  it("evaluates targets that define only a p95 objective", () => {
    expect(
      evaluateStartupSlo(
        Array.from({ length: 100 }, (_, index) => ({
          outcome: "reached" as const,
          durationMs: index >= 98 ? 2_500 : 900,
        })),
        startupSloTargets.contextDiscovery,
      ).meetsObjective,
    ).toBe(true);
  });
});
