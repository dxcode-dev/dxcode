import { describe, expect, it } from "vitest";
import {
  percentageChange,
  type StartupEventRow,
  startupBaselineOptions,
  startupBaselineQuery,
  startupMetricReport,
} from "./startup-baseline-contract.js";

const row = (
  request: string,
  phase: string,
  duration: number,
  occurredAt: string,
  outcome: StartupEventRow["outcome"] = "reached",
): StartupEventRow => ({
  journey: "submission",
  request_id: request,
  thread_id: `thr_${request}`,
  submission_id: `sub_${request}`,
  phase,
  occurred_at: occurredAt,
  outcome,
  duration_ms: duration,
});

describe("startup baseline report", () => {
  it("accepts pnpm's forwarded argument separator", () => {
    expect(
      startupBaselineOptions([
        "--",
        "--since",
        "2026-09-17T00:00:00.000Z",
        "--classification",
        "cold",
      ]),
    ).toEqual(
      new Map([
        ["since", "2026-09-17T00:00:00.000Z"],
        ["classification", "cold"],
      ]),
    );
  });

  it("reports source-backed raw samples, nearest-rank percentiles, and failures", () => {
    const rows = [
      row("a", "request_admitted", 1, "2026-09-17T00:00:00.000Z"),
      row("a", "source_activated", 900, "2026-09-17T00:00:00.900Z"),
      row("a", "model_first_token", 1_100, "2026-09-17T00:00:01.100Z"),
      row("b", "request_admitted", 2, "2026-09-17T00:01:00.000Z"),
      row("b", "source_activated", 800, "2026-09-17T00:01:00.800Z"),
      row("b", "settled", 1_300, "2026-09-17T00:01:01.300Z", "failed"),
    ];

    expect(
      startupMetricReport(rows, "source_backed_first_token", "cold", 10),
    ).toMatchObject({
      classification: "cold",
      sampleCount: 2,
      reached: 1,
      successRate: 0.5,
      p50Ms: 200,
      p95Ms: 200,
      rawSamples: [
        { requestId: "b", outcome: "failed", durationMs: 500 },
        { requestId: "a", outcome: "reached", durationMs: 200 },
      ],
    });
  });

  it("counts cancellation as a terminal failure when the target was not reached", () => {
    const rows = [
      row("cancelled", "request_admitted", 1, "2026-09-17T00:00:00.000Z"),
      row("cancelled", "settled", 80, "2026-09-17T00:00:00.080Z", "cancelled"),
    ];

    expect(startupMetricReport(rows, "scheduling", "cold", 10)).toMatchObject({
      sampleCount: 1,
      reached: 0,
      successRate: 0,
      rawSamples: [{ requestId: "cancelled", outcome: "cancelled" }],
    });
  });

  it("bounds correlations before joining every phase and classifies against prior history", () => {
    const cold = startupBaselineQuery("2026-09-17T00:00:00.000Z", "cold", 7);
    const warm = startupBaselineQuery("2026-09-17T00:00:00.000Z", "warm", 7);

    expect(cold).toContain("AND NOT EXISTS (");
    expect(warm).toContain("AND EXISTS (");
    expect(cold).toContain("prior.occurred_at < opening.occurred_at");
    expect(cold).toContain("LIMIT 7");
    expect(cold).toContain("JOIN selected");
    expect(cold).toContain("classification_history");
    expect(cold).toContain("SELECT MIN(first.occurred_at)");
    expect(cold.trimEnd()).not.toMatch(/LIMIT 7$/);
  });

  it("computes signed percentage change and rejects a zero baseline", () => {
    expect(percentageChange(200, 150)).toBe(-25);
    expect(percentageChange(0, 10)).toBeUndefined();
  });

  it("classifies the first submission per Thread as cold and repeats as warm", () => {
    const rows = [
      row("first", "request_admitted", 1, "2026-09-17T00:00:00.000Z"),
      row("first", "flue_running", 100, "2026-09-17T00:00:00.100Z"),
      {
        ...row("repeat", "request_admitted", 1, "2026-09-17T00:01:00.000Z"),
        thread_id: "thr_first",
      },
      {
        ...row("repeat", "flue_running", 25, "2026-09-17T00:01:00.025Z"),
        thread_id: "thr_first",
      },
    ];

    expect(startupMetricReport(rows, "scheduling", "cold", 10).p50Ms).toBe(100);
    expect(startupMetricReport(rows, "scheduling", "warm", 10).p50Ms).toBe(25);
  });

  it("keeps a sparse correlation intact beside an asymmetric busy event set", () => {
    const busy = [
      row("busy", "request_admitted", 1, "2026-09-17T00:00:00.000Z"),
      ...Array.from({ length: 40 }, (_, index) =>
        row(
          "busy",
          `intermediate_${index}`,
          index + 2,
          `2026-09-17T00:00:${String(index + 1).padStart(2, "0")}.000Z`,
        ),
      ),
      row("busy", "flue_running", 100, "2026-09-17T00:01:00.000Z"),
    ];
    const sparse = [
      row("sparse", "request_admitted", 1, "2026-09-17T00:02:00.000Z"),
      row("sparse", "settled", 20, "2026-09-17T00:02:00.020Z", "cancelled"),
    ];

    expect(
      startupMetricReport([...busy, ...sparse], "scheduling", "cold", 10),
    ).toMatchObject({
      sampleCount: 2,
      reached: 1,
      rawSamples: [
        { requestId: "sparse", outcome: "cancelled" },
        { requestId: "busy", outcome: "reached" },
      ],
    });
  });
});
