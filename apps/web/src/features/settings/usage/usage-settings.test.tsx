import { PersonalUsageDataSchema } from "@dx/api";
import { Schema } from "effect";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { settingsManifest } from "../foundation-sections.js";
import {
  resolveSettingsSection,
  settingsPath,
} from "../settings-registration.js";
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
  it("registers the exact personal route", () => {
    expect(settingsPath({ scope: "personal", section: "usage" })).toBe(
      "/settings/usage",
    );
    expect(
      resolveSettingsSection(settingsManifest, "personal", "usage"),
    ).toMatchObject({
      found: true,
      registration: { id: "personal-usage", label: "Usage" },
    });
  });

  it("renders content-free unknown-aware token, cost, Thread, and E2B views", () => {
    const markup = renderToStaticMarkup(
      <UsageDashboard
        data={data}
        mode="tokens"
        detail="threads"
        onModeChange={() => undefined}
        onDetailChange={() => undefined}
      />,
    );
    expect(markup).toContain("Estimated cost");
    expect(markup).toContain("Usage observability");
    expect(markup).toContain("unknown");
    expect(markup).toContain("E2B");
    expect(markup).toContain("Aggregated in UTC+05:30");
    expect(markup).toContain(
      "not prompts, responses, messages, or tool payloads",
    );
    expect(markup).toContain("180-day deletion policy");
    expect(markup).not.toMatch(/credits|subscription|gift plan/i);
  });
});
