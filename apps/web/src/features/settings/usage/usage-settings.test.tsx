import { PersonalUsageDataSchema } from "@dx/api";
import { Schema } from "effect";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UsageDashboard } from "./usage-settings.js";

const data = Schema.decodeUnknownSync(PersonalUsageDataSchema)({
  range: {
    from: "2026-08-01",
    to: "2026-08-31",
    timezoneOffsetMinutes: 330,
    timezone: "UTC+05:30",
  },
  filters: {},
  summary: {
    tokens: {
      input: 1200,
      output: 400,
      cacheRead: 80,
      cacheWrite: 0,
      reasoning: null,
      total: 1680,
      unknownEvents: 1,
    },
    estimatedCost: {
      amountMicros: 4100,
      currency: "USD",
      estimated: true,
      knownEvents: 1,
      unknownEvents: 1,
    },
    modelTurns: 2,
    averageLatencyMs: 930,
    toolDurationMs: 120,
    runnerDurationMs: 240,
    outcomes: { success: 4, error: 1, cancelled: 0, unknown: 0 },
  },
  daily: [
    {
      day: "2026-08-03",
      totalTokens: 1680,
      unknownTokenEvents: 1,
      estimatedCostMicros: 4100,
      unknownCostEvents: 1,
      averageLatencyMs: 930,
      runnerDurationMs: 240,
      modelTurns: 2,
    },
  ],
  threads: [
    {
      threadId: "thr_00000000-0000-4000-8000-000000000038",
      title: "Trace the usage page",
      projectId: "prj_00000000-0000-4000-8000-000000000038",
      projectName: "Usage observability",
      createdAt: "2026-08-03T07:15:00.000Z",
      providerId: "cloudflare",
      modelId: "@cf/zai-org/glm-5.2",
      profileId: "medium",
      profileVersion: 1,
      totalTokens: 1680,
      unknownTokenEvents: 1,
      estimatedCostMicros: 4100,
      unknownCostEvents: 1,
      averageLatencyMs: 930,
      runnerDurationMs: 240,
      modelTurns: 2,
      errorEvents: 1,
      activity: [
        {
          hour: "2026-08-03T07:00:00.000Z",
          totalTokens: 1680,
          estimatedCostMicros: 4100,
        },
      ],
    },
  ],
  models: [
    {
      providerId: "cloudflare",
      providerName: "Workers AI",
      modelId: "@cf/zai-org/glm-5.2",
      modelName: "GLM 5.2",
      totalTokens: 1680,
      unknownTokenEvents: 1,
      estimatedCostMicros: 4100,
      unknownCostEvents: 1,
      modelTurns: 2,
    },
  ],
  recent: [
    {
      threadId: "thr_00000000-0000-4000-8000-000000000077",
      title: "Recent usage Thread",
      projectName: "dx",
      lastUsedAt: "2026-08-31T09:00:00.000Z",
      totalTokens: 900,
      estimatedCostMicros: 1200,
      unknownCostEvents: 0,
      modelTurns: 1,
    },
  ],
  runners: [
    {
      provider: "e2b",
      profileId: null,
      profileVersion: null,
      template: "dx-workspace",
      cpuCores: 2,
      memoryMb: 1024,
      diskGb: null,
      durationMs: 240,
      events: 1,
      unknownResourceEvents: 1,
    },
  ],
  plugins: [],
  priceSources: [
    {
      source: "catalog",
      sourceVersion: "catalog-v1",
      currency: "USD",
      effectiveFrom: "2026-08-01T00:00:00.000Z",
      effectiveTo: null,
      freshUntil: "2027-01-01T00:00:00.000Z",
      estimated: true,
    },
  ],
});

describe("personal usage settings", () => {
  it("renders content-free, unknown-aware totals, providers, models, days, and Threads", () => {
    const tokens = renderToStaticMarkup(
      <UsageDashboard data={data} mode="tokens" />,
    );
    expect(tokens).toContain("1.7K Total Tokens");
    // The range's own length: 1 to 31 August.
    expect(tokens).toContain("in the last 31 days");
    expect(tokens).toContain("From");
    // Display names, not the stored provider and model ids.
    expect(tokens).toContain("Workers AI");
    expect(tokens).not.toContain(">cloudflare<");
    expect(tokens).toContain("GLM 5.2");
    expect(tokens).toContain("Models");
    expect(tokens).toContain("Trace the usage page");
    expect(tokens).toContain("Last 12 Hours");
    expect(tokens).toContain("Recent usage Thread");
    // The reference's parts only: no Explain Usage, Threads table or CSV.
    expect(tokens).not.toContain("Explain Usage");
    expect(tokens).not.toContain(">Threads<");
    expect(tokens).not.toContain("CSV");
    expect(tokens).toContain("Daily Spend");
    expect(tokens).toContain("Day boundaries are based on UTC.");

    const cost = renderToStaticMarkup(
      <UsageDashboard data={data} mode="cost" />,
    );
    expect(cost).toContain("Total Cost");
    expect(cost).toContain("1 model turn has no price");
    expect(cost).toContain("Daily Spend");
    expect(cost).toContain("$0.0041");
    expect(cost).not.toMatch(/credits|subscription|gift plan/i);
  });
});
