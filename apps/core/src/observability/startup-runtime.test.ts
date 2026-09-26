import { Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  StartupPhaseObservation,
  StartupTraceCorrelation,
} from "./startup-phase.js";
import {
  recordActiveSubmissionPhase,
  recordStartupPhases,
  scheduleStartupPersistence,
  settleSubmissionStartup,
  startSubmissionStartup,
  startupObservation,
  startupServerTiming,
} from "./startup-runtime.js";

const correlation = Schema.decodeUnknownSync(StartupTraceCorrelation)({
  journey: "thread_create",
  requestId: "request-runtime-test",
  threadId: "thr_00000000-0000-4000-8000-000000000235",
});

describe("startup runtime observation", () => {
  it("renders only same-request phase names and durations as Server-Timing", () => {
    const observations = [
      startupObservation(correlation, "request_admitted", 1_000, 1_004),
      startupObservation(correlation, "response_ready", 1_000, 1_019),
    ];

    expect(startupServerTiming(observations)).toBe(
      "dx_request_admitted;dur=4, dx_response_ready;dur=19",
    );
    expect(JSON.stringify(observations)).not.toContain("content");
  });

  it("keeps resident ownership timing on a strict content-free allowlist", () => {
    const terminalCorrelation = Schema.decodeUnknownSync(
      StartupTraceCorrelation,
    )({
      journey: "terminal",
      requestId: "request-resident-privacy",
      threadId: "thr_00000000-0000-4000-8000-000000000307",
    });
    const observation = startupObservation(
      terminalCorrelation,
      "resident_attachment_ready",
      1_000,
      1_019,
    );
    expect(observation).toMatchObject({
      correlation: terminalCorrelation,
      phase: "resident_attachment_ready",
      outcome: "reached",
      durationMs: 19,
    });
    expect(JSON.stringify(observation)).toContain("1970-01-01T00:00:01.019Z");
    for (const forbidden of [
      "cause",
      "content",
      "command",
      "rawFrame",
      "providerId",
      "providerType",
      "pid",
      "tmuxName",
      "path",
      "environmentName",
      "environmentValue",
      "environmentHash",
      "workspaceIdentity",
    ])
      expect(() =>
        Schema.decodeUnknownSync(StartupPhaseObservation)(
          { ...observation, [forbidden]: "forbidden" },
          { onExcessProperty: "error" },
        ),
      ).toThrow();
  });

  it("contains persistence failure without rejecting production work", async () => {
    await expect(
      recordStartupPhases(undefined, [
        startupObservation(correlation, "response_ready", 1_000, 1_019),
      ]),
    ).resolves.toBeUndefined();
  });

  it("hands unresolved persistence to waitUntil without blocking the response", async () => {
    let finish!: () => void;
    const persistence = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const waitUntil = vi.fn();

    await expect(
      scheduleStartupPersistence(() => ({ waitUntil }), persistence),
    ).resolves.toBeUndefined();
    expect(waitUntil).toHaveBeenCalledWith(persistence);
    finish();
  });

  it("waits for persistence only when the local context has no execution context", async () => {
    let finish!: () => void;
    let completed = false;
    const persistence = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const scheduled = scheduleStartupPersistence(() => {
      throw new Error("This context has no ExecutionContext");
    }, persistence).then(() => {
      completed = true;
    });

    await Promise.resolve();
    expect(completed).toBe(false);
    finish();
    await scheduled;
    expect(completed).toBe(true);
  });

  it("falls back to awaiting persistence when waitUntil rejects scheduling", async () => {
    let finish!: () => void;
    let completed = false;
    const persistence = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const scheduled = scheduleStartupPersistence(
      () => ({
        waitUntil: () => {
          throw new Error("Scheduling unavailable");
        },
      }),
      persistence,
    ).then(() => {
      completed = true;
    });

    await Promise.resolve();
    expect(completed).toBe(false);
    finish();
    await scheduled;
    expect(completed).toBe(true);
  });

  it("contains invalid Flue ThreadIds without poisoning the submission chain", async () => {
    const bindings = { DB: undefined } as never;

    await expect(
      startSubmissionStartup(
        bindings,
        "not-a-thread-id",
        "submission-invalid-thread",
        1_000,
      ),
    ).resolves.toBeUndefined();
    await expect(
      recordActiveSubmissionPhase(
        bindings,
        "not-a-thread-id",
        "model_requested",
        1_010,
      ),
    ).resolves.toBeUndefined();
    await expect(
      settleSubmissionStartup(
        bindings,
        "not-a-thread-id",
        "submission-invalid-thread",
        "failed",
        1_020,
      ),
    ).resolves.toBeUndefined();
  });

  it("uses the supplied event timestamp for active submission phases", async () => {
    const threadId = "thr_00000000-0000-4000-8000-000000000236";
    const submissionId = "submission-runtime-236";
    const requestId = "request-runtime-236";
    const startedAt = Date.parse("2026-08-28T12:00:00.000Z");
    const flueRunningAt = startedAt + 10;
    const changesSyncedAt = startedAt + 75;
    const modelRequestedAt = startedAt + 125;
    const writes: Array<ReadonlyArray<unknown>> = [];
    const database = {
      prepare: () => ({
        bind: (...values: ReadonlyArray<unknown>) => ({
          all: async () => ({
            results: [
              {
                request_id: requestId,
                occurred_at: new Date(startedAt).toISOString(),
              },
            ],
          }),
          values,
        }),
      }),
      batch: async (
        statements: ReadonlyArray<{ readonly values: ReadonlyArray<unknown> }>,
      ) => {
        for (const statement of statements) writes.push(statement.values);
        return [];
      },
    } as unknown as D1Database;

    await startSubmissionStartup(
      { DB: database } as never,
      threadId,
      submissionId,
      flueRunningAt,
    );
    await recordActiveSubmissionPhase(
      { DB: database } as never,
      threadId,
      "changes_synced",
      changesSyncedAt,
    );
    await recordActiveSubmissionPhase(
      { DB: database } as never,
      threadId,
      "model_requested",
      modelRequestedAt,
    );
    await settleSubmissionStartup(
      { DB: database } as never,
      threadId,
      submissionId,
      "reached",
      modelRequestedAt + 1,
    );

    expect(writes.map((values) => values[4])).toEqual([
      "flue_running",
      "changes_synced",
      "model_requested",
      "settled",
    ]);
    expect(writes[2]?.[6]).toBe(new Date(modelRequestedAt).toISOString());
    expect(writes[2]?.[9]).toBe(modelRequestedAt - startedAt);
  });
});
