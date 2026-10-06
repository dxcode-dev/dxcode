import type { FlueObservation, FlueObservationSubscriber } from "@flue/runtime";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  observe: vi.fn(),
  lifecycleInfo: vi.fn(),
  modelInfo: vi.fn(),
  toolInfo: vi.fn(),
  persistenceWarn: vi.fn(),
  recordUsage: vi.fn(() => Promise.resolve()),
  recordThreadActivity: vi.fn(() => Promise.resolve()),
  startSubmissionStartup: vi.fn(() => Promise.resolve()),
  recordActiveSubmissionPhase: vi.fn(() => Promise.resolve()),
  settleSubmissionStartup: vi.fn(() => Promise.resolve()),
}));

vi.mock("@flue/runtime", () => ({ observe: mocks.observe }));
vi.mock("../logging.js", () => ({
  agentLifecycleLogger: { info: mocks.lifecycleInfo },
  agentModelLogger: { info: mocks.modelInfo },
  agentToolLogger: { info: mocks.toolInfo },
  settingsPersistenceLogger: { warn: mocks.persistenceWarn },
}));
vi.mock("../settings/usage/recorder.js", () => ({
  recordFlueUsage: mocks.recordUsage,
}));
vi.mock("../threads/activity.js", () => ({
  recordFlueThreadActivity: mocks.recordThreadActivity,
}));
vi.mock("./startup-runtime.js", () => ({
  startSubmissionStartup: mocks.startSubmissionStartup,
  recordActiveSubmissionPhase: mocks.recordActiveSubmissionPhase,
  settleSubmissionStartup: mocks.settleSubmissionStartup,
}));

import { installFlueObservation } from "./flue.js";

const observation = (value: Record<string, unknown>) =>
  value as unknown as FlueObservation;

let subscriber: FlueObservationSubscriber;

beforeAll(() => {
  installFlueObservation();
  installFlueObservation();
  expect(mocks.observe).toHaveBeenCalledOnce();
  subscriber = mocks.observe.mock.calls[0]?.[0] as FlueObservationSubscriber;
});

beforeEach(() => {
  mocks.lifecycleInfo.mockReset();
  mocks.modelInfo.mockReset();
  mocks.toolInfo.mockReset();
  mocks.persistenceWarn.mockReset();
  mocks.recordUsage.mockReset();
  mocks.recordUsage.mockResolvedValue(undefined);
  mocks.recordThreadActivity.mockReset();
  mocks.recordThreadActivity.mockResolvedValue(undefined);
  mocks.startSubmissionStartup.mockReset();
  mocks.startSubmissionStartup.mockResolvedValue(undefined);
  mocks.recordActiveSubmissionPhase.mockReset();
  mocks.recordActiveSubmissionPhase.mockResolvedValue(undefined);
  mocks.settleSubmissionStartup.mockReset();
  mocks.settleSubmissionStartup.mockResolvedValue(undefined);
});

describe("Flue observation", () => {
  it("installs only one isolate-local subscriber", () => {
    expect(mocks.observe).toHaveBeenCalledOnce();
  });

  it("maps only allowlisted submission fields", () => {
    subscriber(
      observation({
        type: "submission_running",
        v: 3,
        eventIndex: 4,
        timestamp: "2026-08-20T12:00:00.000Z",
        agentName: "dx-agent",
        instanceId: "thr_test",
        submissionId: "sub_test",
        kind: "direct",
        attemptCount: 2,
        maxAttempts: 10,
        conversationId: "must-not-log",
        session: "must-not-log",
        errorInfo: { message: "secret" },
        agentInput: { text: "secret prompt" },
      }),
      {} as never,
    );

    expect(mocks.lifecycleInfo).toHaveBeenCalledWith(
      "Flue submission running.",
      {
        event: "submission_running",
        agentName: "dx-agent",
        threadId: "thr_test",
        submissionId: "sub_test",
        kind: "direct",
        attemptCount: 2,
        maxAttempts: 10,
      },
    );
    expect(mocks.recordThreadActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "submission_running",
        instanceId: "thr_test",
      }),
      expect.anything(),
    );
  });

  it("extracts only allowlisted model metadata and token counts", () => {
    subscriber(
      observation({
        type: "turn",
        agentName: "dx-agent",
        instanceId: "thr_test",
        submissionId: "sub_test",
        turnId: "turn_test",
        purpose: "agent",
        durationMs: 25,
        isError: false,
        request: {
          providerName: "Cloudflare Workers AI",
          requestedModel: "@cf/zai-org/glm-5.2",
          input: { systemPrompt: "secret", messages: ["secret"] },
        },
        response: {
          output: "secret model output",
          usage: {
            input: 10,
            output: 5,
            cacheRead: 3,
            cacheWrite: 2,
            totalTokens: 20,
            cost: { total: 99 },
          },
        },
        args: { token: "secret" },
      }),
      {} as never,
    );

    expect(mocks.modelInfo).toHaveBeenCalledWith("Flue model turn completed.", {
      event: "turn",
      agentName: "dx-agent",
      threadId: "thr_test",
      submissionId: "sub_test",
      turnId: "turn_test",
      purpose: "agent",
      providerName: "Cloudflare Workers AI",
      requestedModel: "@cf/zai-org/glm-5.2",
      durationMs: 25,
      isError: false,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 3,
      cacheWriteTokens: 2,
      totalTokens: 20,
    });
    expect(mocks.recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "turn", turnId: "turn_test" }),
      expect.anything(),
    );
  });

  it("records first meaningful output without model content", async () => {
    await subscriber(
      observation({
        type: "turn_first_output",
        timestamp: "2026-08-28T12:00:00.000Z",
        instanceId: "thr_test",
        submissionId: "sub_test",
        turnId: "turn_test",
        purpose: "agent",
        outputKind: "text",
        durationMs: 18,
        providerName: "cloudflare",
        requestedModel: "model",
        delta: "private output",
      }),
      { env: {} } as never,
    );

    expect(mocks.recordActiveSubmissionPhase).toHaveBeenCalledWith(
      {},
      "thr_test",
      "model_first_token",
      Date.parse("2026-08-28T12:00:00.000Z"),
    );
    expect(JSON.stringify(mocks.modelInfo.mock.calls)).not.toContain(
      "private output",
    );
  });

  it("contains startup phase delivery failures without rejecting Flue", async () => {
    mocks.recordActiveSubmissionPhase.mockRejectedValueOnce(
      new Error("startup persistence failed"),
    );

    await expect(
      subscriber(
        observation({
          type: "turn_start",
          timestamp: "2026-08-28T12:00:00.000Z",
          instanceId: "thr_test",
          submissionId: "sub_test",
          turnId: "turn_test",
          purpose: "agent",
        }),
        { env: {} } as never,
      ),
    ).resolves.toBeUndefined();

    expect(mocks.persistenceWarn).toHaveBeenCalledWith(
      "Startup phase observation could not be delivered.",
      {
        event: "startup_phase_delivery_failed",
        source: "flue",
        observationType: "turn_start",
        threadId: "thr_test",
        submissionId: "sub_test",
      },
    );
  });

  it("logs compaction start and outcome without the summary or error", () => {
    subscriber(
      observation({
        type: "compaction_start",
        agentName: "dx-agent",
        instanceId: "thr_test",
        submissionId: "sub_test",
        reason: "threshold",
        estimatedTokens: 251_000,
      }),
      {} as never,
    );
    subscriber(
      observation({
        type: "compaction",
        agentName: "dx-agent",
        instanceId: "thr_test",
        submissionId: "sub_test",
        messagesBefore: 120,
        messagesAfter: 9,
        durationMs: 4_200,
        isError: true,
        error: { message: "secret summary failure" },
      }),
      {} as never,
    );

    const correlation = {
      agentName: "dx-agent",
      threadId: "thr_test",
      submissionId: "sub_test",
    };
    expect(mocks.modelInfo).toHaveBeenCalledWith("Flue compaction started.", {
      event: "compaction_start",
      ...correlation,
      reason: "threshold",
      estimatedTokens: 251_000,
    });
    expect(mocks.modelInfo).toHaveBeenCalledWith("Flue compaction completed.", {
      event: "compaction",
      ...correlation,
      isError: true,
      messagesBefore: 120,
      messagesAfter: 9,
      durationMs: 4_200,
    });
    expect(JSON.stringify(mocks.modelInfo.mock.calls)).not.toContain("secret");
  });

  it("maps tool outcome without arguments or results", () => {
    subscriber(
      observation({
        type: "tool",
        agentName: "dx-agent",
        instanceId: "thr_test",
        submissionId: "sub_test",
        toolCallId: "tool_test",
        toolName: "read",
        durationMs: 12,
        isError: false,
        args: { path: "/secret" },
        result: "secret file content",
        effectiveResult: "secret file content",
      }),
      {} as never,
    );

    expect(mocks.toolInfo).toHaveBeenCalledWith(
      "Flue tool execution completed.",
      {
        event: "tool",
        agentName: "dx-agent",
        threadId: "thr_test",
        submissionId: "sub_test",
        toolCallId: "tool_test",
        toolName: "read",
        durationMs: 12,
        isError: false,
      },
    );
  });

  it("ignores content-bearing event variants", () => {
    subscriber(
      observation({
        type: "turn_request",
        request: { systemPrompt: "secret" },
      }),
      {} as never,
    );
    subscriber(
      observation({ type: "message_end", message: "secret output" }),
      {} as never,
    );

    expect(mocks.lifecycleInfo).not.toHaveBeenCalled();
    expect(mocks.modelInfo).not.toHaveBeenCalled();
    expect(mocks.toolInfo).not.toHaveBeenCalled();
  });

  it("lets subscriber failures reach Flue's containment boundary", () => {
    const failure = new Error("log sink failed");
    mocks.lifecycleInfo.mockImplementationOnce(() => {
      throw failure;
    });

    expect(() =>
      subscriber(observation({ type: "agent_start" }), {} as never),
    ).toThrow(failure);
  });

  it("contains asynchronous usage persistence failures with content-free logging", async () => {
    mocks.recordUsage.mockRejectedValueOnce(
      new Error("private persistence cause"),
    );
    const delivery = subscriber(
      observation({
        type: "idle",
        instanceId: "thr_test",
        prompt: "never log this",
      }),
      {} as never,
    );
    expect(delivery).toBeInstanceOf(Promise);
    await delivery;

    expect(mocks.persistenceWarn).toHaveBeenCalledWith(
      "Usage observation could not be recorded.",
      {
        event: "usage_record_failed",
        source: "flue",
        observationType: "idle",
        threadId: "thr_test",
      },
    );
    expect(JSON.stringify(mocks.persistenceWarn.mock.calls)).not.toContain(
      "never log this",
    );
  });

  it("serializes Thread activity delivery in Flue observation order", async () => {
    let finishQueued: () => void = () => undefined;
    mocks.recordThreadActivity
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishQueued = resolve;
          }),
      )
      .mockResolvedValueOnce(undefined);

    const queued = subscriber(
      observation({
        type: "submission_queued",
        instanceId: "thr_test",
        submissionId: "sub_test",
        timestamp: "2026-08-20T12:00:00.000Z",
      }),
      {} as never,
    );
    const running = subscriber(
      observation({
        type: "submission_running",
        instanceId: "thr_test",
        submissionId: "sub_test",
        timestamp: "2026-08-20T12:01:00.000Z",
      }),
      {} as never,
    );
    await Promise.resolve();
    expect(mocks.recordThreadActivity).toHaveBeenCalledTimes(1);

    finishQueued();
    await queued;
    await running;

    expect(
      (
        mocks.recordThreadActivity.mock.calls as unknown as ReadonlyArray<
          readonly [FlueObservation]
        >
      ).map(([event]) => event.type),
    ).toEqual(["submission_queued", "submission_running"]);
  });
});
