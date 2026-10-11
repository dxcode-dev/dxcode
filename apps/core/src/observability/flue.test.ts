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
