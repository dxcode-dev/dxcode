import { Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import { startupObservabilityLogger } from "../logging.js";
import { StartupTraceCorrelation } from "./startup-phase.js";
import {
  recordActiveSubmissionPhase,
  recordStartupPhases,
  scheduleStartupPersistence,
  settleSubmissionStartup,
  startSubmissionStartup,
  startupObservation,
} from "./startup-runtime.js";

const correlation = Schema.decodeUnknownSync(StartupTraceCorrelation)({
  journey: "thread_create",
  requestId: "request-runtime-test",
  threadId: "thr_00000000-0000-4000-8000-000000000235",
});

describe("startup runtime observation", () => {
  it("contains persistence failure without rejecting production work", async () => {
    await expect(
      recordStartupPhases(undefined, [
        startupObservation(correlation, "response_ready", 1_000, 1_019),
      ]),
    ).resolves.toBeUndefined();
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
  it("logs the bounded persistence failure reason", async () => {
    const warn = vi
      .spyOn(startupObservabilityLogger, "warn")
      .mockImplementation(() => {});
    const database = {
      prepare: () => ({ bind: () => ({}) }),
      batch: async () => {
        throw new Error(
          `D1_ERROR: startup phase transition rejected: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)${"x".repeat(2_000)}`,
        );
      },
    } as unknown as D1Database;
    try {
      await recordStartupPhases(database, [
        startupObservation(correlation, "response_ready", 1_000, 1_019),
      ]);
      expect(warn).toHaveBeenCalledOnce();
      const properties = (warn.mock.calls[0] as unknown[])[1] as Record<
        string,
        unknown
      >;
      expect(properties).toMatchObject({
        event: "startup_phase_record_failed",
        operation: "startup-phase.record",
        phases: ["response_ready"],
        errorName: "Error",
      });
      expect(properties.errorMessage).toContain(
        "D1_ERROR: startup phase transition rejected",
      );
      expect((properties.errorMessage as string).length).toBeLessThanOrEqual(
        500,
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("does not record an active submission phase that arrives after a later one", async () => {
    // The initial Changes sync settles in the background, so changes_synced
    // can arrive after the model request; D1 rejects that transition.
    const threadId = "thr_00000000-0000-4000-8000-000000000237";
    const submissionId = "submission-runtime-237";
    const startedAt = Date.parse("2026-08-28T12:00:00.000Z");
    const writes: Array<ReadonlyArray<unknown>> = [];
    const database = {
      prepare: () => ({
        bind: (...values: ReadonlyArray<unknown>) => ({
          all: async () => ({
            results: [
              {
                request_id: "request-runtime-237",
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
    const bindings = { DB: database } as never;

    await startSubmissionStartup(bindings, threadId, submissionId, startedAt);
    await recordActiveSubmissionPhase(
      bindings,
      threadId,
      "model_requested",
      startedAt + 10,
    );
    await recordActiveSubmissionPhase(
      bindings,
      threadId,
      "changes_synced",
      startedAt + 20,
    );
    await recordActiveSubmissionPhase(
      bindings,
      threadId,
      "model_requested",
      startedAt + 30,
    );
    await recordActiveSubmissionPhase(
      bindings,
      threadId,
      "model_first_token",
      startedAt + 40,
    );
    await settleSubmissionStartup(
      bindings,
      threadId,
      submissionId,
      "reached",
      startedAt + 50,
    );

    expect(writes.map((values) => values[4])).toEqual([
      "flue_running",
      "model_requested",
      "model_first_token",
      "settled",
    ]);
  });
});
