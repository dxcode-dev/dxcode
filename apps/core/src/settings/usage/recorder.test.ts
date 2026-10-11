import type { FlueObservation } from "@flue/runtime";
import { describe, expect, it } from "vitest";
import { usageEventFromFlue } from "./recorder.js";

const observation = (value: Record<string, unknown>) =>
  value as unknown as FlueObservation;

describe("usage recorder", () => {
  it("maps public Flue response hooks to content-free model attribution and counts", () => {
    const event = usageEventFromFlue(
      observation({
        type: "turn",
        timestamp: "2026-08-23T10:00:00.000Z",
        instanceId: "thr_00000000-0000-4000-8000-000000000038",
        submissionId: "sub-38",
        turnId: "turn-38",
        purpose: "agent",
        durationMs: 82.4,
        isError: false,
        request: {
          providerId: "cloudflare",
          providerName: "Cloudflare Workers AI",
          requestedModel: "@cf/zai-org/glm-5.2",
          input: { messages: [{ content: "must never be retained" }] },
        },
        response: {
          responseModel: "@cf/zai-org/glm-5.2-202608",
          output: "must never be retained",
          usage: {
            input: 100,
            output: 40,
            cacheRead: 12,
            cacheWrite: 2,
            totalTokens: 154,
          },
        },
      }),
    );

    expect(event).toMatchObject({
      kind: "model",
      threadId: "thr_00000000-0000-4000-8000-000000000038",
      observedProviderId: "cloudflare",
      observedModelId: "@cf/zai-org/glm-5.2-202608",
      inputTokens: 100,
      outputTokens: 40,
      cacheReadTokens: 12,
      cacheWriteTokens: 2,
      reasoningTokens: null,
      totalTokens: 154,
      durationMs: 82,
      outcome: "success",
    });
    expect(event).not.toHaveProperty("request");
    expect(event).not.toHaveProperty("response");
    expect(event).not.toHaveProperty("input");
    expect(event).not.toHaveProperty("output");
    expect(event).not.toHaveProperty("messages");
    expect(JSON.stringify(event)).not.toContain("must never be retained");
  });

  it("records only tool identity, origin, categorical outcome, and duration", () => {
    const event = usageEventFromFlue(
      observation({
        type: "tool",
        timestamp: "2026-08-23T10:00:01.000Z",
        instanceId: "thr_00000000-0000-4000-8000-000000000038",
        submissionId: "sub-38",
        toolCallId: "call-38",
        toolName: "read",
        origin: "model",
        durationMs: 17,
        isError: true,
        args: { path: "/private/payload" },
        result: "secret result",
      }),
    );

    expect(event).toMatchObject({
      kind: "tool",
      toolCallId: "call-38",
      toolName: "read",
      toolOrigin: "model",
      runtime: "flue",
      outcome: "error",
      durationMs: 17,
    });
    expect(event).not.toHaveProperty("args");
    expect(event).not.toHaveProperty("result");
    expect(event).not.toHaveProperty("effectiveResult");
    expect(JSON.stringify(event)).not.toMatch(/private|secret/i);
  });
});
