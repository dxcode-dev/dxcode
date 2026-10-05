import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  GetWorkspaceUsageResponseSchema,
  InspectWorkspacePrivateThreadRequestSchema,
  WORKSPACE_CONTENT_SUMMARY_UNAVAILABLE_REASON,
  WorkspaceUsageQuerySchema,
} from "./workspace-usage.js";

describe("workspace usage API", () => {
  it("accepts bounded aggregate filters without a Thread aggregate seam", () => {
    const query = Schema.decodeUnknownSync(WorkspaceUsageQuerySchema)({
      from: "2026-08-01",
      to: "2026-08-31",
      timezoneOffsetMinutes: "0",
      ranking: "projects",
      limit: "20",
    });
    expect(query).toMatchObject({ ranking: "projects", limit: 20 });
    expect(query).not.toHaveProperty("threadId");
    expect(() =>
      Schema.decodeUnknownSync(WorkspaceUsageQuerySchema)({
        ...query,
        ranking: "threads",
      }),
    ).toThrow();
  });

  it("bounds private inspection reasons at the wire contract", () => {
    const threadId = "thr_00000000-0000-4000-8000-000000000042";
    expect(
      Schema.decodeUnknownSync(InspectWorkspacePrivateThreadRequestSchema)({
        threadId,
        reason: "Approved incident investigation",
      }),
    ).toMatchObject({ threadId });
    for (const reason of ["", "x".repeat(501)]) {
      expect(() =>
        Schema.decodeUnknownSync(InspectWorkspacePrivateThreadRequestSchema)({
          threadId,
          reason,
        }),
      ).toThrow();
    }
  });

  it("encodes aggregate-only data and honest unavailable capabilities", () => {
    const response = Schema.decodeUnknownSync(GetWorkspaceUsageResponseSchema)({
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
            cacheRead: 0,
            cacheWrite: 0,
            reasoning: null,
            total: 15,
            unknownEvents: 0,
          },
          estimatedCost: {
            amountMicros: 0,
            currency: "USD",
            estimated: true,
            knownEvents: 0,
            unknownEvents: 1,
          },
          modelTurns: 1,
          averageLatencyMs: 100,
          toolDurationMs: 0,
          runnerDurationMs: 0,
          outcomes: { success: 1, error: 0, cancelled: 0, unknown: 0 },
        },
        daily: [],
        ranking: { kind: "users", items: [] },
        runners: [],
        plugins: [
          {
            pluginId: "search",
            pluginName: "Web search",
            providerId: "exa",
            providerName: "Exa",
            capability: "web.search",
            credentialScope: "deployment",
            unit: "request",
            units: 2,
            events: 2,
            outcomes: { success: 2, error: 0 },
          },
        ],
        pluginUsers: [
          {
            userId: "workspace-usage-member",
            userName: "Member",
            pluginId: "search",
            pluginName: "Web search",
            providerId: "exa",
            providerName: "Exa",
            capability: "web.search",
            credentialScope: "deployment",
            unit: "request",
            units: 2,
            events: 2,
            outcomes: { success: 2, error: 0 },
          },
        ],
        priceSources: [],
        privateInspection: {
          permitted: false,
          requiredRole: "auditor",
          contentSummary: {
            available: false,
            reason: WORKSPACE_CONTENT_SUMMARY_UNAVAILABLE_REASON,
          },
        },
      },
    });

    expect(response.data).not.toHaveProperty("threads");
    expect(response.data.pluginUsers[0]).not.toHaveProperty("threadId");
    expect(response.data).not.toHaveProperty("prompts");
    expect(response.data).not.toHaveProperty("responses");
    expect(response.data).not.toHaveProperty("messages");
    expect(response.data.privateInspection.contentSummary.available).toBe(
      false,
    );
  });
});
