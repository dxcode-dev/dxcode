import type { FlueObservation } from "@flue/runtime";
import { describe, expect, it, vi } from "vitest";
import {
  fetchUsageRouteAttribution,
  runnerResourceAttribution,
  usageEventFromFlue,
} from "./recorder.js";

const observation = (value: Record<string, unknown>) =>
  value as unknown as FlueObservation;

describe("usage recorder", () => {
  it("reads exact safe attribution from the submission's thread coordinator", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        connectionId: "connection-canonical",
        providerId: "anthropic",
        modelId: "claude-canonical",
      }),
    );
    const get = vi.fn(() => ({ fetch }));
    const idFromName = vi.fn(() => ({ id: "coordinator" }));

    await expect(
      fetchUsageRouteAttribution(
        {
          BYOK_CREDENTIAL_COORDINATOR: { get, idFromName },
        } as never,
        "thread-38",
        "submission-38",
      ),
    ).resolves.toEqual({
      connectionId: "connection-canonical",
      providerId: "anthropic",
      modelId: "claude-canonical",
    });
    expect(idFromName).toHaveBeenCalledWith("byok-thread-38");
    expect(fetch).toHaveBeenCalledWith(
      "https://dx-byok.invalid/usage-route",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          threadId: "thread-38",
          submissionId: "submission-38",
        }),
      }),
    );
  });

  it("only treats a genuine 404 as unavailable", async () => {
    const bindings = (status: number) =>
      ({
        BYOK_CREDENTIAL_COORDINATOR: {
          idFromName: () => ({}),
          get: () => ({ fetch: async () => new Response(null, { status }) }),
        },
      }) as never;
    await expect(
      fetchUsageRouteAttribution(bindings(404), "thread", "submission"),
    ).resolves.toBeUndefined();
    await expect(
      fetchUsageRouteAttribution(bindings(503), "thread", "submission"),
    ).rejects.toThrow("status 503");
  });

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

  it("exposes the runner-profile adapter seam while preserving real observations", () => {
    expect(
      runnerResourceAttribution(
        {
          id: "compute-medium",
          resources: { cpuCores: 2, memoryMb: 4096, diskGb: 20 },
        },
        { cpuCores: 4, memoryMb: 8192 },
        3,
      ),
    ).toEqual({
      profileId: "compute-medium",
      profileVersion: 3,
      cpuCores: 4,
      memoryMb: 8192,
      diskGb: 20,
    });
  });
});
