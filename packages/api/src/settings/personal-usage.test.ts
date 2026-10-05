import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  GetPersonalUsageResponseSchema,
  PersonalUsageQuerySchema,
  PluginUsageDataSchema,
} from "./personal-usage.js";

describe("personal usage API", () => {
  it("decodes bounded typed filters", () => {
    expect(
      Schema.decodeUnknownSync(PersonalUsageQuerySchema)({
        from: "2026-08-01",
        to: "2026-08-31",
        timezoneOffsetMinutes: "-420",
        limit: "25",
        providerId: "cloudflare",
      }),
    ).toMatchObject({ timezoneOffsetMinutes: -420, limit: 25 });
  });

  it("encodes content-free aggregate data with explicit unknowns", () => {
    const response = Schema.encodeUnknownSync(GetPersonalUsageResponseSchema)({
      status: "success",
      data: {
        range: {
          from: "2026-08-01",
          to: "2026-08-31",
          timezoneOffsetMinutes: 0,
          timezone: "UTC",
        },
        filters: {},
        summary: {
          tokens: {
            input: 10,
            output: 5,
            cacheRead: 2,
            cacheWrite: 0,
            reasoning: null,
            total: 17,
            unknownEvents: 1,
          },
          estimatedCost: {
            amountMicros: 0,
            currency: "USD",
            estimated: true,
            knownEvents: 0,
            unknownEvents: 1,
          },
          modelTurns: 1,
          averageLatencyMs: 42,
          toolDurationMs: 0,
          runnerDurationMs: 0,
          outcomes: { success: 1, error: 0, cancelled: 0, unknown: 0 },
        },
        daily: [],
        threads: [],
        runners: [],
        plugins: [],
        priceSources: [],
      },
    });
    const encoded = JSON.stringify(response);
    expect(encoded).toContain('"reasoning":null');
    expect(encoded).not.toMatch(/prompt|response|message|payload|toolResult/i);
  });

  it("decodes plugin usage for any ledger plugin and unit, without prices", () => {
    const row = {
      pluginId: "speech",
      pluginName: "Dictation",
      providerId: "sarvam",
      providerName: "Sarvam",
      capability: "speech.transcribe",
      credentialScope: "deployment",
      unit: "audio_second",
      units: 42,
      events: 3,
      outcomes: { success: 2, error: 1 },
    };
    expect(Schema.decodeUnknownSync(PluginUsageDataSchema)(row)).toEqual(row);
    expect(Object.keys(row)).not.toContain("estimatedCost");
    expect(() =>
      Schema.decodeUnknownSync(PluginUsageDataSchema)({
        ...row,
        credentialScope: "operator",
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(PluginUsageDataSchema)({ ...row, pluginId: "" }),
    ).toThrow();
  });
});
